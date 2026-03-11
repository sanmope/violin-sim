# Violin Session

Real-time collaborative violin practice app. Two musicians connect and see each other's pitch, FFT spectrum, and mel spectrogram with minimal latency.

## Architecture

```
Musician's device (Mac or phone browser)
├── audio_client.py        ← pyaudio + aubio (YIN pitch detection) [Mac native]
│   ├── pitch + mel + fft  → ws://localhost:8001 → React "Vos" panel (instant)
│   └── audio chunks       → ws://SERVER/audio   → pipeline server
│
│  — OR —
│
├── browserAudio.js        ← Web Audio API + JS YIN (browser fallback)
│   ├── pitch + mel + fft  → React callback (instant)
│   └── audio chunks       → ws://SERVER/audio   → pipeline server
│
Server (Docker / Kubernetes)
├── pipeline_server.py     ← FastAPI + scipy (mel + log-FFT processing)
├── spacetimedb            ← multiplayer state relay (audio_frame table)
└── nginx                  ← serves React frontend + proxies WebSockets
```

### Data flow for "Otro musico"

```
Mic → audio_client / browserAudio → ws://.../audio → pipeline_server
  → compute mel + FFT → SpacetimeDB publish_frame
  → React subscribes → filters out own client_id → renders remote panel
```

## Stack

| Layer | Technology |
|---|---|
| Audio capture (Mac) | pyaudio + aubio (YIN pitch detection) |
| Audio capture (browser) | Web Audio API + ScriptProcessorNode + JS YIN |
| Backend | FastAPI + uvicorn |
| Mel processing | scipy spectrogram + manual filterbank (no librosa/numba) |
| FFT processing | Log-spaced 256-bin magnitude spectrum (49 Hz – 2637 Hz) |
| Multiplayer relay | SpacetimeDB (Rust WASM module) |
| Frontend | React + Vite |
| Container | Docker + nginx |
| Orchestration | Kubernetes (Minikube for local dev) |

## Requirements

**Server**
- Docker (via Colima or Docker Desktop)
- kubectl + Minikube (optional, for k8s deployment)

**Native audio client (Mac)**
- Python 3.12
- `brew install portaudio aubio`

**Browser audio (phone/laptop)**
- Chrome or Safari with mic permission
- For phone over LAN (HTTP): enable `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and add `http://<server-ip>:5173`

## Setup

### 1. Install dependencies

```bash
# Frontend
npm install

# Native audio client (optional, Mac only)
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-client.txt
```

### 2. Run locally

```bash
# Terminal 1 — server + SpacetimeDB
docker-compose up

# Terminal 2 — frontend (dev mode)
npm run dev
```

Open `http://localhost:5173`. The app will try to connect to `audio_client.py` on `ws://localhost:8001`. If no native client is running, it automatically falls back to browser mic capture after 3 seconds.

**Optional: native audio client (lower latency)**
```bash
# Terminal 3
source .venv/bin/activate
python violin_backend/audio_client.py <session-id> --server ws://localhost:8000/audio
```

### 3. Run on Kubernetes (Minikube)

```bash
minikube start
eval $(minikube docker-env)
docker build -t violin-server:latest .
minikube addons enable ingress
kubectl apply -f k8s/

# Get service URLs
minikube service violin-server --url
# First URL = nginx (port 80) → open in browser
# Second URL = API (port 8000) → audio client target
```

### 4. Connect from phone (LAN)

1. Find your Mac's LAN IP (e.g. `192.168.1.x`)
2. On phone Chrome, go to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
3. Add `http://192.168.1.x:5173` and relaunch Chrome
4. Open `http://192.168.1.x:5173` — mic capture starts automatically
5. Both devices should use the same session ID (default: `session-default`)

## Usage

Two musicians join the same session. Each sees the other's pitch and spectrum in real time.

**With native client (Mac):**
```bash
# Musician A
python violin_backend/audio_client.py jam-session --server ws://yourserver.com/audio

# Musician B
python violin_backend/audio_client.py jam-session --server ws://yourserver.com/audio
```

**With browser audio (any device):**

Just open the URL in the browser — mic capture starts automatically. Each browser instance generates a unique client ID so multiple devices in the same session see each other.

## Audio Pipeline

| Parameter | Value |
|---|---|
| Sample rate | 44100 Hz |
| Buffer size | 2048 samples (~46 ms) |
| Pitch algorithm | YIN (aubio native / JS implementation) |
| Noise gate | RMS threshold 0.03 |
| FFT bins | 256 (log-spaced, 49 Hz – 2637 Hz) |
| Mel bins | 64 |
| Ring buffer | 4410 samples (100 ms) |

When audio drops below the noise gate, no frames are sent — the UI retains the last frame rather than going to zero.

## SpacetimeDB Integration

The server uses SpacetimeDB as a multiplayer relay for audio frames between musicians.

**Tables:** `Session`, `SessionMember`, `AudioFrame`

**Reducers:** `create_session`, `join_session`, `publish_frame`, `leave_session`

The pipeline server calls `publish_frame` via HTTP after computing mel + FFT. React subscribes to `audio_frame` via the SpacetimeDB JS SDK and filters frames by `client_id` to show only the remote musician's data.

```bash
# Rebuild SpacetimeDB module after schema changes
docker build -f spacetimedb.Dockerfile -t spacetimedb-violin .

# Regenerate TypeScript bindings
spacetime generate --lang typescript --out-dir src/module_bindings --bin-path /tmp/violin_session.wasm
```

## Project Structure

```
violin-sim/
├── violin_backend/
│   ├── audio_client.py         # Native client (pyaudio + aubio) — Mac
│   └── pipeline_server.py      # FastAPI server (mel + FFT + SpacetimeDB)
├── src/
│   ├── ViolinSession.jsx       # React UI (tuner + FFT + waterfall + pitch diff)
│   ├── browserAudio.js         # Browser audio capture (Web Audio API + JS YIN)
│   └── module_bindings/        # SpacetimeDB generated TypeScript bindings
├── server-module/
│   └── src/lib.rs              # SpacetimeDB Rust module (tables + reducers)
├── k8s/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ingress.yaml
├── violin-android/             # Android project (WebView + native audio, experimental)
├── Dockerfile                  # Multi-stage: React build + Python server + nginx
├── spacetimedb.Dockerfile      # SpacetimeDB standalone server + WASM module
├── docker-compose.yml          # pipeline_server + spacetimedb
├── nginx.conf
└── docker-entrypoint.sh
```

## Latency

| Path | Latency |
|---|---|
| Local pitch + FFT ("Vos") | ~0 ms (direct callback) |
| Remote musician via SpacetimeDB | ~60–100 ms |

## Roadmap

- [ ] Deploy to cloud (EKS / GKE / DigitalOcean) with fixed URL
- [ ] HTTPS support for mobile mic without Chrome flags
- [ ] Vibrato analysis
- [ ] Android native client (React Native)
