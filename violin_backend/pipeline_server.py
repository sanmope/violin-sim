# pipeline_server.py
import asyncio
import json
import numpy as np
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from dataclasses import dataclass, field
from typing import Callable, Awaitable

SAMPLE_RATE = 44100
FMIN        = 196.0
FMAX        = 3520.0
N_MELS      = 64
BUFFER_CONFIGS = [
    {"name": "fast",   "window": SAMPLE_RATE // 20, "n_mels": 32},   # 50ms
    {"name": "mid",    "window": SAMPLE_RATE // 10, "n_mels": 64},   # 100ms
    {"name": "smooth", "window": SAMPLE_RATE // 4,  "n_mels": 128},  # 250ms
]

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


# --- Session: agrupa los clientes conectados ---

class Session:
    def __init__(self, session_id: str):
        self.session_id = session_id
        # cliente_id → websocket de React (para recibir frames del otro músico)
        self.react_clients: dict[str, WebSocket] = {}
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

    def add_react_client(self, client_id: str, ws: WebSocket):
        self.react_clients[client_id] = ws
        print(f"[session:{self.session_id}] react client conectado: {client_id}")

    def remove_react_client(self, client_id: str):
        self.react_clients.pop(client_id, None)
        print(f"[session:{self.session_id}] react client desconectado: {client_id}")

    async def broadcast_to_react(self, sender_id: str, payload: bytes):
        """Enviar frame a todos los React clients EXCEPTO al propio sender."""
        dead = []
        for client_id, ws in self.react_clients.items():
            if client_id == sender_id:
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(client_id)
        for d in dead:
            self.react_clients.pop(d, None)


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


async def process_chunk(session: Session, client_id: str, payload: dict) -> list[bytes]:
    """
    Recibe un chunk de audio, actualiza los ring buffers y
    devuelve una lista de frames serializados (uno por buffer config).
    """
    chunk = np.array(payload["chunk"], dtype=np.float32)
    pitch = payload["pitch"]
    ts    = payload["ts"]

    frames = []
    loop   = asyncio.get_event_loop()

    for cfg in BUFFER_CONFIGS:
        if client_id not in session.ring_buffers: return []
        ring = session.ring_buffers[client_id][cfg["name"]]
        ring.push(chunk)

        # Mel en executor para no bloquear el event loop
        mel = await loop.run_in_executor(
            None, compute_mel, ring.data, cfg["n_mels"]
        )

        frame = json.dumps({
            "ts":        ts,
            "buf":       cfg["name"],
            "client_id": client_id,
            "pitch":     round(float(pitch), 2),
            "mel":       mel.tolist(),
        })

        frames.append(frame)

    return frames


# --- WebSocket: audio client (Python, en el host del músico) ---

@app.websocket("/audio")
async def audio_endpoint(ws: WebSocket):
    await ws.accept()
    session_id = ws.query_params.get("session_id", "default")
    client_id  = ws.query_params.get("client_id",  "unknown")

    session = get_or_create_session(session_id)
    session.add_audio_client(client_id)

    try:
        while True:
            data    = await ws.receive_text()
            payload = json.loads(data)

            frames = await process_chunk(session, client_id, payload)

            # Fan-out a los React clients de la sesión
            for frame_bytes in frames:
                await session.broadcast_to_react(client_id, frame_bytes)

    except WebSocketDisconnect:
        session.remove_audio_client(client_id)


# --- WebSocket: React client (browser) ---

@app.websocket("/react")
async def react_endpoint(ws: WebSocket):
    await ws.accept()
    session_id = ws.query_params.get("session_id", "default")
    client_id  = ws.query_params.get("client_id",  "unknown")

    session = get_or_create_session(session_id)
    session.add_react_client(client_id, ws)

    try:
        # Mantener la conexion viva con pings periodicos
        while True:
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=10.0)
            except asyncio.TimeoutError:
                await ws.send_text("ping")
    except WebSocketDisconnect:
        session.remove_react_client(client_id)


# --- Health check ---

@app.get("/health")
def health():
    return {
        "status": "ok",
        "sessions": {
            sid: {
                "audio_clients": list(s.ring_buffers.keys()),
                "react_clients": list(s.react_clients.keys()),
            }
            for sid, s in sessions.items()
        }
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")