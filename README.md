# 🎻 Violin Session

Real-time collaborative violin practice app. Two musicians connect and see each other's pitch and spectral analysis with minimal latency.

## Architecture
```
Mac (lightweight client)
├── audio_client.py     ← pyaudio + aubio (pitch detection)
│   ├── pitch local  → ws://localhost:8001 → React "VOS" (instant)
│   └── audio chunks → ws://SERVER/audio  → pipeline server
│
Server (Docker / Kubernetes)
├── pipeline_server.py  ← FastAPI + scipy (mel spectrogram)
└── nginx               ← serves React frontend + proxies WebSockets
```

## Stack

| Layer | Technology |
|---|---|
| Audio capture | pyaudio + aubio (YIN pitch detection) |
| Backend | FastAPI + uvicorn |
| Mel processing | scipy (no librosa/numba) |
| Frontend | React + Vite |
| Container | Docker + nginx |
| Orchestration | Kubernetes (Minikube for local dev) |

## Requirements

**Server**
- Docker
- kubect)**
- Python 3.12
- `brew install portaudio aubio` (macOS)

## Setup

### 1. Install client dependencies
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-client.txt
```

### 2. Run locally (without Kubernetes)
```bash
# Terminal 1 — server
docker-compose up

# Terminal 2 — audio nt
python violin_backend/audio_client.py <session-id> --server ws://localhost:8000/audio

# Terminal 3 — frontend (dev mode)
npm install
npm run dev
```

Open `http://localhost:5173`

### 3. Run on Kubernetes (Minikube)
```bash
# Start Minikube and build image
minikube start
eval $(minikube docker-env)
docker build -t violin-server:latest .

# Enable ingress and deploy
minikube addons enable ingre
kubectl apply -f k8s/

# Get service URLs
minikube service violin-server --url
# First URL = nginx (port 80) → open in browser
# Second URL = API (port 8000) → use for audio client

# Connect audio client
python violin_backend/audio_client.py <session-id> --server ws://<SECOND_URL>/audio
```

### 4. Build frontend for production
```bash
npm run build
```

The Dockerfile includes a multi-stage build — React is compiled and served by nginx inside the container.

## Usage

Two musicians join the same session:
```bash
# Musician A
python violin_backend/audio_client.py jam-session-1 --server ws://rver.com/audio

# Musician B (different machine)
python violin_backend/audio_client.py jam-session-1 --server ws://yourserver.com/audio
```

Both open `http://yourserver.com` in the browser. Each sees the other's pitch and mel spectrogram in real time.

## Latency

| Path | Latency |
|---|---|
| Local pitch (tuner "Vos") | ~0ms |
| Mel own signal | ~60-80ms |
| Other musician's signal | ~60-80ms |

## Project Structure
```
violin-sim/
├── violin_backend├── audio_client.py       # Lightweight client (pyaudio + aubio)
│   └── pipeline_server.py    # FastAPI WebSocket server
├── src/
│   └── ViolinSession.jsx     # React UI (tuner + waterfall + energy bars)
├── k8s/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ingress.yaml
├── Dockerfile                # Multi-stage: React build + Python server + nginx
├── docker-compose.yml
├── nginx.conf
└── docker-entrypoint.sh
```

## Roadmap

- [ ] SpacetimeDB for real multiplayer (replace WebSocket relay)
- [ ] Own spectrogram (send mel
- [ ] Vibrato analysis
- [ ] Deploy to cloud (EKS / GKE / DigitalOcean)
