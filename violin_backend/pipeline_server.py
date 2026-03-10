# pipeline_server.py
import asyncio
import json
import os
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import httpx

SAMPLE_RATE = 44100
FMIN        = 49.0
FMAX        = 2637.0
N_MELS      = 64
BUFFER_CONFIGS = [
    {"name": "fast",   "window": SAMPLE_RATE // 20, "n_mels": 32},   # 50ms
    {"name": "mid",    "window": SAMPLE_RATE // 10, "n_mels": 64},   # 100ms
    {"name": "smooth", "window": SAMPLE_RATE // 4,  "n_mels": 128},  # 250ms
]

SPACETIMEDB_URL = os.environ.get("SPACETIMEDB_URL", "http://localhost:3000")
STDB_DB_NAME    = os.environ.get("STDB_DB_NAME", "violin-session")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

http_client: httpx.AsyncClient | None = None


@app.on_event("startup")
async def startup():
    global http_client
    http_client = httpx.AsyncClient(timeout=5.0)


@app.on_event("shutdown")
async def shutdown():
    if http_client:
        await http_client.aclose()


# --- SpacetimeDB HTTP helpers ---

async def stdb_call(reducer: str, args: list):
    """Call a SpacetimeDB reducer via HTTP API."""
    url = f"{SPACETIMEDB_URL}/v1/database/{STDB_DB_NAME}/call/{reducer}"
    try:
        resp = await http_client.post(url, json=args)
        if resp.status_code not in (200, 204):
            print(f"[stdb] {reducer} failed: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"[stdb] {reducer} error: {e}")


# --- Ring buffer ---

class RingBuffer:
    def __init__(self, size: int):
        self._buf = np.zeros(size, dtype=np.float32)

    def push(self, chunk: np.ndarray):
        n = len(chunk)
        self._buf = np.concatenate([self._buf[n:], chunk])

    @property
    def data(self) -> np.ndarray:
        return self._buf.copy()


# --- Session: agrupa los audio clients conectados ---

class Session:
    def __init__(self, session_id: str):
        self.session_id = session_id
        # cliente_id → ring buffers propios
        self.ring_buffers: dict[str, dict[str, RingBuffer]] = {}

    def add_audio_client(self, client_id: str):
        self.ring_buffers[client_id] = {
            cfg["name"]: RingBuffer(cfg["window"]) for cfg in BUFFER_CONFIGS
        }
        print(f"[session:{self.session_id}] audio client conectado: {client_id}")

    def remove_audio_client(self, client_id: str):
        self.ring_buffers.pop(client_id, None)
        print(f"[session:{self.session_id}] audio client desconectado: {client_id}")


# --- Store de sesiones ---

sessions: dict[str, Session] = {}

def get_or_create_session(session_id: str) -> Session:
    if session_id not in sessions:
        sessions[session_id] = Session(session_id)
    return sessions[session_id]


# --- Procesamiento mel ---

def _mel_filterbank(sr, n_fft, n_mels, fmin, fmax):
    def hz_to_mel(hz): return 2595 * np.log10(1 + hz / 700)
    def mel_to_hz(mel): return 700 * (10 ** (mel / 2595) - 1)
    mel_points = np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2)
    hz_points  = mel_to_hz(mel_points)
    bin_points = np.floor((n_fft + 1) * hz_points / sr).astype(int)
    n_bins = n_fft // 2 + 1
    filters = np.zeros((n_mels, n_bins))
    for m in range(1, n_mels + 1):
        fl, fc, fr = bin_points[m-1], bin_points[m], bin_points[m+1]
        for k in range(fl, fc):
            if fc != fl: filters[m-1, k] = (k - fl) / (fc - fl)
        for k in range(fc, fr):
            if fr != fc: filters[m-1, k] = (fr - k) / (fr - fc)
    return filters

def compute_mel(window: np.ndarray, n_mels: int) -> np.ndarray:
    from scipy.signal import spectrogram as sp_spec
    freqs, times, Sxx = sp_spec(window, fs=SAMPLE_RATE, nperseg=512, noverlap=256)
    mel_fb   = _mel_filterbank(SAMPLE_RATE, n_fft=512, n_mels=n_mels, fmin=FMIN, fmax=FMAX)
    n_bins   = mel_fb.shape[1]
    mel      = mel_fb @ Sxx[:n_bins, :]
    mel_db   = 10 * np.log10(mel + 1e-9)
    mel_norm = (mel_db - mel_db.min()) / (mel_db.max() - mel_db.min() + 1e-6)
    return mel_norm.mean(axis=1).astype(np.float32)


async def process_and_publish(session: Session, client_id: str, payload: dict):
    """
    Recibe un chunk de audio, actualiza los ring buffers,
    calcula mel y publica cada frame a SpacetimeDB.
    """
    chunk = np.array(payload["chunk"], dtype=np.float32)
    pitch = payload["pitch"]
    ts    = payload["ts"]

    loop = asyncio.get_event_loop()

    for cfg in BUFFER_CONFIGS:
        if client_id not in session.ring_buffers:
            return
        ring = session.ring_buffers[client_id][cfg["name"]]
        ring.push(chunk)

        # Mel en executor para no bloquear el event loop
        mel = await loop.run_in_executor(
            None, compute_mel, ring.data, cfg["n_mels"]
        )

        # Publicar a SpacetimeDB (fire-and-forget style)
        asyncio.create_task(stdb_call("publish_frame", [
            session.session_id,
            client_id,
            cfg["name"],
            ts,
            round(float(pitch), 2),
            mel.tolist(),
        ]))


# --- WebSocket: audio client (Python, en el host del músico) ---

@app.websocket("/audio")
async def audio_endpoint(ws: WebSocket):
    await ws.accept()
    session_id = ws.query_params.get("session_id", "default")
    client_id  = ws.query_params.get("client_id",  "unknown")

    session = get_or_create_session(session_id)
    session.add_audio_client(client_id)

    # Register in SpacetimeDB
    await stdb_call("join_session", [session_id, client_id])

    try:
        while True:
            data    = await ws.receive_text()
            payload = json.loads(data)
            await process_and_publish(session, client_id, payload)

    except WebSocketDisconnect:
        session.remove_audio_client(client_id)
        await stdb_call("leave_session", [session_id, client_id])


# --- Health check ---

@app.get("/health")
def health():
    return {
        "status": "ok",
        "spacetimedb": SPACETIMEDB_URL,
        "sessions": {
            sid: {
                "audio_clients": list(s.ring_buffers.keys()),
            }
            for sid, s in sessions.items()
        }
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
