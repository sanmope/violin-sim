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

class AudioClient:
    def __init__(self, session_id: str, server_ws: str = SERVER_WS):
        self.session_id = session_id
        self.server_ws  = f"{server_ws}?session_id={session_id}&client_id={session_id}-audio"

        self.pitch_detector = aubio.pitch("yin", BUFFER_SIZE, BUFFER_SIZE, SAMPLE_RATE)
        self.pitch_detector.set_unit("Hz")
        self.pitch_detector.set_tolerance(0.8)

        self.server_queue: asyncio.Queue = asyncio.Queue(maxsize=20)
        self.local_queue:  asyncio.Queue = asyncio.Queue(maxsize=20)

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
                pitch = float(self.pitch_detector(chunk)[0])
                ts    = int(time.time() * 1000)

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
