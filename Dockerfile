# Stage 1 — build React
FROM node:20-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2 — servidor Python + frontend estático
FROM python:3.12-slim

RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    libsndfile1 \
    ffmpeg \
    nginx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=frontend /app/dist /var/www/html

COPY requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt
COPY violin_backend/pipeline_server.py .
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

COPY nginx.conf /etc/nginx/sites-available/default

EXPOSE 80 8000

CMD ["./docker-entrypoint.sh"]
