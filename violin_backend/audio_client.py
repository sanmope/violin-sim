import asyncio
import json
import threading
import time
import numpy as np
import aubio
import pyaudio
import websockets
import websockets

SAMPLE_RATE = 44100
BUFFER_SIZE = SAMPLE_RATE // 20
SERVER_WS   = "ws://localhost:8000/audio"

# Noise gate: ignore chunks below this RMS level (filters fans, AC, etc.)
RMS_THRESHOLD = 0.03
# Pitch confidence: aubio returns 0.0-1.0, reject below this
CONFIDENCE_THRESHOLD = 0.7

# Local mel config (matches pipeline_server "mid" buffer)
LOCAL_N_MELS = 64
LOCAL_FMIN   = 49.0
LOCAL_FMAX   = 2637.0
LOCAL_WINDOW = SAMPLE_RATE // 10  # 100ms ring buffer


def _build_mel_filterbank(sr, n_fft, n_mels, fmin, fmax):
    hz2mel = lambda hz: 2595 * np.log10(1 + hz / 700)
    mel2hz = lambda m: 700 * (10 ** (m / 2595) - 1)
    mel_pts = np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2)
    hz_pts  = mel2hz(mel_pts)
    bins    = np.floor((n_fft + 1) * hz_pts / sr).astype(int)
    n_bins  = n_fft // 2 + 1
    fb      = np.zeros((n_mels, n_bins))
    for m in range(1, n_mels + 1):
        fl, fc, fr = bins[m-1], bins[m], bins[m+1]
        for k in range(fl, fc):
            if fc != fl: fb[m-1, k] = (k - fl) / (fc - fl)
        for k in range(fc, fr):
            if fr != fc: fb[m-1, k] = (fr - k) / (fr - fc)
    return fb

MEL_FB = _build_mel_filterbank(SAMPLE_RATE, 512, LOCAL_N_MELS, LOCAL_FMIN, LOCAL_FMAX)


def compute_local_mel(window):
    from scipy.signal import spectrogram as sp_spec
    _, _, Sxx = sp_spec(window, fs=SAMPLE_RATE, nperseg=512, noverlap=256)
    n_bins = MEL_FB.shape[1]
    mel    = MEL_FB @ Sxx[:n_bins, :]
    mel_db = 10 * np.log10(mel + 1e-9)
    mel_norm = (mel_db - mel_db.min()) / (mel_db.max() - mel_db.min() + 1e-6)
    return mel_norm.mean(axis=1).astype(np.float32)


N_FFT_BINS = 256

def compute_local_fft(window):
    """Log-frequency magnitude spectrum from fmin to fmax."""
    spectrum = np.abs(np.fft.rfft(window))
    freqs    = np.fft.rfftfreq(len(window), 1.0 / SAMPLE_RATE)

    # Log-spaced bin edges from fmin to fmax
    log_edges = np.logspace(np.log10(LOCAL_FMIN), np.log10(LOCAL_FMAX), N_FFT_BINS + 1)
    binned = np.zeros(N_FFT_BINS, dtype=np.float64)
    for i in range(N_FFT_BINS):
        mask = (freqs >= log_edges[i]) & (freqs < log_edges[i + 1])
        if mask.any():
            binned[i] = spectrum[mask].mean()

    # Normalize to 0..1
    mx = binned.max()
    if mx > 1e-9:
        binned /= mx
    return binned.astype(np.float32)

class AudioClient:
    def __init__(self, session_id: str, server_ws: str = SERVER_WS):
        self.session_id = session_id
        self.server_ws  = f"{server_ws}?session_id={session_id}&client_id={session_id}-audio"

        self.pitch_detector = aubio.pitch("yin", BUFFER_SIZE, BUFFER_SIZE, SAMPLE_RATE)
        self.pitch_detector.set_unit("Hz")
        self.pitch_detector.set_tolerance(CONFIDENCE_THRESHOLD)

        self.server_queue: asyncio.Queue = asyncio.Queue(maxsize=20)
        self.local_queue:  asyncio.Queue = asyncio.Queue(maxsize=20)

        # Ring buffer for local mel computation
        self._ring = np.zeros(LOCAL_WINDOW, dtype=np.float32)

    def _capture_thread(self, loop: asyncio.AbstractEventLoop):
        pa = pyaudio.PyAudio()
        stream = pa.open(
            format=pyaudio.paFloat32,
            channels=1,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=BUFFER_SIZE,
        )
        print(f"[audio_client] Captura iniciada — buffer={BUFFER_SIZE/SAMPLE_RATE*1000:.0f}ms")
        try:
            while True:
                raw   = stream.read(BUFFER_SIZE, exception_on_overflow=False)
                chunk = np.frombuffer(raw, dtype=np.float32).copy()

                # Noise gate
                rms = float(np.sqrt(np.mean(chunk ** 2)))
                ts  = int(time.time() * 1000)

                if rms < RMS_THRESHOLD:
                    continue

                pitch = float(self.pitch_detector(chunk)[0])
                confidence = float(self.pitch_detector.get_confidence())

                # Skip if pitch detection is not confident enough
                if confidence < CONFIDENCE_THRESHOLD:
                    pitch = 0.0

                # Update ring buffer and compute local mel + fft
                n = len(chunk)
                self._ring = np.concatenate([self._ring[n:], chunk])
                mel = compute_local_mel(self._ring)
                fft = compute_local_fft(self._ring)

                server_payload = {
                    "session_id": self.session_id,
                    "ts":         ts,
                    "pitch":      round(pitch, 2),
                    "sr":         SAMPLE_RATE,
                    "chunk":      chunk.tolist(),
                }
                local_payload = {
                    "type":  "pitch",
                    "ts":    ts,
                    "pitch": round(pitch, 2),
                    "mel":   mel.tolist(),
                    "fft":   fft.tolist(),
                }
                asyncio.run_coroutine_threadsafe(self.server_queue.put(server_payload), loop)
                asyncio.run_coroutine_threadsafe(self.local_queue.put(local_payload), loop)

        except Exception as e:
            print(f"[audio_client] Captura detenida: {e}")
        finally:
            stream.stop_stream()
            stream.close()
            pa.terminate()

    async def _server_sender(self):
        while True:
            try:
                async with websockets.connect(self.server_ws) as ws:
                    print(f"[audio_client] Conectado al servidor: {self.server_ws}")
                    while True:
                        payload = await self.server_queue.get()
                        await ws.send(json.dumps(payload))
            except Exception as e:
                print(f"[audio_client] Servidor desconectado: {e} — reintentando en 2s")
                await asyncio.sleep(2)

    async def _local_broadcaster(self):
        connected_clients = set()

        async def handler(ws):
            connected_clients.add(ws)
            print(f"[audio_client] Rct conectado al servidor local")
            try:
                async for _ in ws:
                    pass
            except Exception:
                pass
            finally:
                connected_clients.discard(ws)
                print(f"[audio_client] React desconectado del servidor local")

        async with websockets.serve(handler, "localhost", 8001):
            print(f"[audio_client] Servidor local en ws://localhost:8001")
            while True:
                payload = await self.local_queue.get()
                dead = set()
                for ws in connected_clients.copy():
                    try:
                        await ws.send(json.dumps(payload))
                    except Exception:
                        dead.add(ws)
                connected_clients -= dead

    async def run(self):
        loop = asyncio.get_event_loop()
        t = threading.Thread(target=self._capture_thread, args=(loop,), daemon=True)
        t.start()

        print(f"[audio_client] Sesion: {self.session_id}")
        print(f"[audio_client] Servidor : {self.server_ws}")
        print(f"[audio_client] React local: ws://localhost:8001")

        await asyncio.gather(
            self._server_sender(),
            self._local_broadcaster(),
        )


if __name__ == "__main__":
    import sys
    import argparse
    parser = argparse.ArgumentParser(description="Violin audio client")
    parser.add_argument("session_id", nargs="?", default="session-default", help="ID de sesion")
    parser.add_argument("--server", default="ws://localhost:8000/audio", help="URL del servidor WebSocket")
    args = parser.parse_args()
    client = AudioClient(session_id=args.session_id, server_ws=args.server)
    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        print("\n[audio_client] Detenido.")
