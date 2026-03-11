// Browser-based audio capture with YIN pitch detection and log-spaced FFT.
// Replaces audio_client.py when running on mobile or without a local client.

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 2048;        // closest power-of-2 to 2205 (required by ScriptProcessor)
const RMS_THRESHOLD = 0.03;
const CONFIDENCE_THRESHOLD = 0.7;
const FMIN = 49.0;
const FMAX = 2637.0;
const N_FFT_BINS = 256;
const N_MEL_BINS = 64;
const RING_SIZE = 4410;          // 100ms ring buffer

// --- YIN pitch detection ---

function yinDetect(buffer, sampleRate) {
  const half = Math.floor(buffer.length / 2);
  const yinBuf = new Float32Array(half);

  // Difference function
  for (let tau = 0; tau < half; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const d = buffer[j] - buffer[j + tau];
      sum += d * d;
    }
    yinBuf[tau] = sum;
  }

  // Cumulative mean normalized difference
  yinBuf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < half; tau++) {
    runningSum += yinBuf[tau];
    yinBuf[tau] = runningSum > 0 ? (yinBuf[tau] * tau) / runningSum : 1;
  }

  // Absolute threshold
  let tauEst = -1;
  for (let tau = 2; tau < half; tau++) {
    if (yinBuf[tau] < CONFIDENCE_THRESHOLD) {
      while (tau + 1 < half && yinBuf[tau + 1] < yinBuf[tau]) tau++;
      tauEst = tau;
      break;
    }
  }

  if (tauEst < 0) return { pitch: 0, confidence: 0 };

  // Parabolic interpolation
  let betterTau = tauEst;
  if (tauEst > 0 && tauEst < half - 1) {
    const s0 = yinBuf[tauEst - 1], s1 = yinBuf[tauEst], s2 = yinBuf[tauEst + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tauEst + (s0 - s2) / denom;
  }

  return {
    pitch: sampleRate / betterTau,
    confidence: 1 - yinBuf[tauEst],
  };
}

// --- Cooley-Tukey FFT ---

function fft(real, imag) {
  const n = real.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wR = Math.cos(angle), wI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let k = 0; k < halfLen; k++) {
        const tR = curR * real[i+k+halfLen] - curI * imag[i+k+halfLen];
        const tI = curR * imag[i+k+halfLen] + curI * real[i+k+halfLen];
        real[i+k+halfLen] = real[i+k] - tR;
        imag[i+k+halfLen] = imag[i+k] - tI;
        real[i+k] += tR;
        imag[i+k] += tI;
        const newR = curR * wR - curI * wI;
        curI = curR * wI + curI * wR;
        curR = newR;
      }
    }
  }
}

// --- Log-spaced FFT (matches audio_client.py) ---

const logEdges = new Float64Array(N_FFT_BINS + 1);
const logMin = Math.log10(FMIN), logMax = Math.log10(FMAX);
for (let i = 0; i <= N_FFT_BINS; i++) {
  logEdges[i] = Math.pow(10, logMin + (i / N_FFT_BINS) * (logMax - logMin));
}

function computeLogFft(window) {
  // Zero-pad to next power of 2
  let n = 1;
  while (n < window.length) n <<= 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < window.length; i++) real[i] = window[i];

  fft(real, imag);

  // Magnitude of positive frequencies
  const nBins = (n >> 1) + 1;
  const mag = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) {
    mag[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
  }
  const freqRes = SAMPLE_RATE / n;

  // Bin into log-spaced buckets
  const binned = new Float32Array(N_FFT_BINS);
  for (let i = 0; i < N_FFT_BINS; i++) {
    const fLow = logEdges[i], fHigh = logEdges[i + 1];
    let sum = 0, count = 0;
    const kLow = Math.max(0, Math.floor(fLow / freqRes));
    const kHigh = Math.min(nBins - 1, Math.floor(fHigh / freqRes));
    for (let k = kLow; k <= kHigh; k++) {
      const freq = k * freqRes;
      if (freq >= fLow && freq < fHigh) { sum += mag[k]; count++; }
    }
    if (count > 0) binned[i] = sum / count;
  }

  // Normalize 0..1
  let mx = 0;
  for (let i = 0; i < N_FFT_BINS; i++) if (binned[i] > mx) mx = binned[i];
  if (mx > 1e-9) for (let i = 0; i < N_FFT_BINS; i++) binned[i] /= mx;

  return binned;
}

// --- Simplified mel from FFT ---

const melFilterbank = buildMelFilterbank();

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

function buildMelFilterbank() {
  const nFft = 512;
  const nBins = nFft / 2 + 1;  // 257
  const melPts = new Float64Array(N_MEL_BINS + 2);
  const melMin = hzToMel(FMIN), melMax = hzToMel(FMAX);
  for (let i = 0; i < melPts.length; i++) {
    melPts[i] = melMin + (i / (N_MEL_BINS + 1)) * (melMax - melMin);
  }
  const hzPts = melPts.map(melToHz);
  const binPts = hzPts.map(hz => Math.floor((nFft + 1) * hz / SAMPLE_RATE));

  const fb = [];
  for (let m = 0; m < N_MEL_BINS; m++) {
    const row = new Float32Array(nBins);
    const fl = binPts[m], fc = binPts[m + 1], fr = binPts[m + 2];
    for (let k = fl; k < fc; k++) if (fc !== fl) row[k] = (k - fl) / (fc - fl);
    for (let k = fc; k < fr; k++) if (fr !== fc) row[k] = (fr - k) / (fr - fc);
    fb.push(row);
  }
  return fb;
}

function computeMel(window) {
  // Simple: single-frame 512-point FFT, apply filterbank
  const n = 512;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  // Hann window, use last 512 samples
  const offset = Math.max(0, window.length - n);
  for (let i = 0; i < n && offset + i < window.length; i++) {
    real[i] = window[offset + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  }
  fft(real, imag);

  const nBins = n / 2 + 1;
  const power = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) {
    power[k] = real[k] * real[k] + imag[k] * imag[k];
  }

  const mel = new Float32Array(N_MEL_BINS);
  for (let m = 0; m < N_MEL_BINS; m++) {
    let dot = 0;
    for (let k = 0; k < nBins; k++) dot += melFilterbank[m][k] * power[k];
    mel[m] = 10 * Math.log10(dot + 1e-9);
  }

  // Normalize 0..1
  let mn = mel[0], mx = mel[0];
  for (let i = 1; i < N_MEL_BINS; i++) { if (mel[i] < mn) mn = mel[i]; if (mel[i] > mx) mx = mel[i]; }
  const range = mx - mn + 1e-6;
  for (let i = 0; i < N_MEL_BINS; i++) mel[i] = (mel[i] - mn) / range;

  return mel;
}

// --- Main: start browser audio capture ---

export function startBrowserAudio(onFrame, serverWsUrl, sessionId, clientId) {
  let ringBuffer = new Float32Array(RING_SIZE);
  let serverWs = null;
  let stopped = false;

  // Connect to pipeline server (send raw chunks, same as audio_client.py)
  function connectServer() {
    if (stopped || !serverWsUrl) return;
    try {
      const url = `${serverWsUrl}?session_id=${sessionId}&client_id=${clientId}`;
      serverWs = new WebSocket(url);
      serverWs.onclose = () => { if (!stopped) setTimeout(connectServer, 2000); };
      serverWs.onerror = () => {};
    } catch (e) {
      setTimeout(connectServer, 2000);
    }
  }
  connectServer();

  // Start mic capture
  navigator.mediaDevices.getUserMedia({ audio: { sampleRate: SAMPLE_RATE, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    .then(async (stream) => {
      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      // Mobile browsers require resume after user gesture
      if (audioCtx.state === "suspended") await audioCtx.resume();
      console.log("[browserAudio] AudioContext state:", audioCtx.state, "sampleRate:", audioCtx.sampleRate);

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);

      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (stopped) return;
        const chunk = e.inputBuffer.getChannelData(0);

        // RMS noise gate
        let sumSq = 0;
        for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
        const rms = Math.sqrt(sumSq / chunk.length);
        if (rms < RMS_THRESHOLD) return;

        // YIN pitch detection
        const { pitch, confidence } = yinDetect(chunk, SAMPLE_RATE);
        const finalPitch = confidence >= CONFIDENCE_THRESHOLD ? pitch : 0;
        const ts = Date.now();

        // Update ring buffer
        const n = chunk.length;
        const newRing = new Float32Array(RING_SIZE);
        newRing.set(ringBuffer.subarray(n));
        newRing.set(chunk, RING_SIZE - n);
        ringBuffer = newRing;

        // Compute FFT and mel
        const fftData = computeLogFft(ringBuffer);
        const melData = computeMel(ringBuffer);

        // Send to React
        onFrame({
          type: "pitch",
          ts,
          pitch: Math.round(finalPitch * 100) / 100,
          fft: Array.from(fftData),
          mel: Array.from(melData),
        });

        // Send to pipeline server
        if (serverWs && serverWs.readyState === WebSocket.OPEN) {
          serverWs.send(JSON.stringify({
            session_id: sessionId,
            ts,
            pitch: Math.round(finalPitch * 100) / 100,
            sr: SAMPLE_RATE,
            chunk: Array.from(chunk),
          }));
        }
      };

      // Store cleanup refs
      startBrowserAudio._cleanup = { audioCtx, stream, processor, source };
    })
    .catch(err => {
      console.error("[browserAudio] Mic access denied:", err);
    });

  // Return stop function
  return () => {
    stopped = true;
    if (serverWs) serverWs.close();
    const c = startBrowserAudio._cleanup;
    if (c) {
      c.processor.disconnect();
      c.source.disconnect();
      c.stream.getTracks().forEach(t => t.stop());
      c.audioCtx.close();
    }
  };
}
