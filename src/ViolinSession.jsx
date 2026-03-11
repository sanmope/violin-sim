import { useState, useEffect, useRef, useCallback } from "react";
import { DbConnection } from "./module_bindings";
import { startBrowserAudio } from "./browserAudio";

const N_MELS = 64;
const WATERFALL_ROWS = 80;
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTE_LATIN = ["Do","Do#","Re","Re#","Mi","Fa","Fa#","Sol","Sol#","La","La#","Si"];
const SESSION_ID = import.meta.env.VITE_SESSION_ID || "mi-sesion-123";
// CLIENT_ID must match the audio source's client_id so we filter out our own frames
// audio_client.py uses: `${SESSION_ID}-audio`
// browserAudio.js uses: `${SESSION_ID}-browser`
const STDB_HOST  = import.meta.env.VITE_STDB_HOST || window.__VIOLIN_SERVER_IP || window.location.hostname;
const STDB_URL   = `ws://${STDB_HOST}:3000`;

// 2 octaves below G3 to 2 octaves above E5
const FMIN = 49;
const FMAX = 2637;
const LOG_FMIN = Math.log10(FMIN);
const LOG_FRANGE = Math.log10(FMAX) - LOG_FMIN;
function hzToLogPos(hz) {
  return (Math.log10(hz) - LOG_FMIN) / LOG_FRANGE;
}

// Note frequency helpers
function noteToHz(name, octave) {
  const idx = NOTE_NAMES.indexOf(name);
  if (idx < 0) return 0;
  const midi = idx + (octave + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function hzToNoteInfo(hz) {
  if (!hz || hz < 50) return null;
  const semitones = 12 * Math.log2(hz / 440) + 69;
  const noteIdx = ((Math.round(semitones) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(semitones) / 12) - 1;
  const cents = Math.round((semitones - Math.round(semitones)) * 100);
  return { note: `${NOTE_NAMES[noteIdx]}${octave}`, latin: NOTE_LATIN[noteIdx], cents, hz: hz.toFixed(1) };
}

// Generate all notes in FMIN..FMAX matching scale intervals
function notesInRange(intervals, root) {
  const notes = [];
  for (let octave = 0; octave <= 9; octave++) {
    for (const semi of intervals) {
      const noteIdx = (root + semi) % 12;
      const oct = octave + Math.floor((root + semi) / 12) - Math.floor(root / 12);
      const hz = noteToHz(NOTE_NAMES[noteIdx], oct);
      if (hz >= FMIN && hz <= FMAX) {
        notes.push({ name: NOTE_NAMES[noteIdx], latin: NOTE_LATIN[noteIdx], octave: oct, hz });
      }
    }
  }
  return notes.sort((a, b) => a.hz - b.hz);
}

const SCALE_DEFS = [
  { label: "Ninguna", notes: [] },
  { label: "Cuerdas violín (G D A E)", notes: [
    { name: "G", latin: "Sol", octave: 3, hz: noteToHz("G", 3) },
    { name: "D", latin: "Re", octave: 4, hz: noteToHz("D", 4) },
    { name: "A", latin: "La", octave: 4, hz: noteToHz("A", 4) },
    { name: "E", latin: "Mi", octave: 5, hz: noteToHz("E", 5) },
  ]},
  { label: "Cromática", get: () => notesInRange([0,1,2,3,4,5,6,7,8,9,10,11], 0) },
];
const MAJOR = [0,2,4,5,7,9,11];
const NAT_MINOR = [0,2,3,5,7,8,10];
const HARM_MINOR = [0,2,3,5,7,8,11];
const PENTATONIC = [0,2,4,7,9];
const BLUES = [0,3,5,6,7,10];
NOTE_NAMES.forEach((n, i) => {
  const lat = NOTE_LATIN[i];
  SCALE_DEFS.push({ label: `${n} (${lat}) Mayor`, get: () => notesInRange(MAJOR, i) });
  SCALE_DEFS.push({ label: `${n} (${lat}) Menor`, get: () => notesInRange(NAT_MINOR, i) });
  SCALE_DEFS.push({ label: `${n} (${lat}) Menor armónica`, get: () => notesInRange(HARM_MINOR, i) });
  SCALE_DEFS.push({ label: `${n} (${lat}) Pentatónica`, get: () => notesInRange(PENTATONIC, i) });
  SCALE_DEFS.push({ label: `${n} (${lat}) Blues`, get: () => notesInRange(BLUES, i) });
});

// --- Components ---

function NoteMarkers({ scaleNotes, height }) {
  if (!scaleNotes || !scaleNotes.length) return null;
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height, pointerEvents: "none" }}>
      {scaleNotes.map((n, i) => {
        const pos = hzToLogPos(n.hz);
        if (pos < 0 || pos > 1) return null;
        return (
          <div key={i} style={{ position: "absolute", left: `${pos * 100}%`, top: 0, height: "100%" }}>
            <div style={{ position: "absolute", top: 0, bottom: 16, width: 1, background: "#ffffff18" }} />
            <div style={{ position: "absolute", bottom: 0, transform: "translateX(-50%)",
              fontSize: 8, color: "#666", whiteSpace: "nowrap", fontFamily: "monospace" }}>
              {n.latin}{n.octave}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Tuner({ pitch, label, color }) {
  const info = hzToNoteInfo(pitch);
  const cents = info?.cents ?? 0;
  const angle = Math.max(-45, Math.min(45, cents * 0.9));
  const inTune = Math.abs(cents) < 5;
  return (
    <div style={{ background: "#0f0f1a", border: `1px solid ${color}33`, borderRadius: 12, padding: "10px 14px", flex: 1 }}>
      <div style={{ color: "#555", fontSize: 9, letterSpacing: 2, marginBottom: 2 }}>{label.toUpperCase()}</div>
      <svg width="100%" viewBox="0 0 160 85" style={{ display: "block" }}>
        <path d="M18 78 A62 62 0 0 1 142 78" fill="none" stroke="#1a1a2e" strokeWidth="4"/>
        <path d="M55 24 A62 62 0 0 1 105 24" fill="none" stroke="#00ff8822" strokeWidth="6"/>
        {[-3,-2,-1,0,1,2,3].map(i => {
          const rad = ((i / 3) * 45 - 90) * Math.PI / 180;
          return <line key={i}
            x1={80 + 56 * Math.cos(rad)} y1={78 + 56 * Math.sin(rad)}
            x2={80 + 47 * Math.cos(rad)} y2={78 + 47 * Math.sin(rad)}
            stroke={i === 0 ? "#00ff88" : "#333"} strokeWidth={i === 0 ? 2 : 1}/>;
        })}
        <line x1="80" y1="78"
          x2={80 + 52 * Math.cos((angle - 90) * Math.PI / 180)}
          y2={78 + 52 * Math.sin((angle - 90) * Math.PI / 180)}
          stroke={color} strokeWidth="2.5" strokeLinecap="round"
          style={{ transition: "all 80ms ease-out" }}/>
        <circle cx="80" cy="78" r="4" fill={color}/>
      </svg>
      <div style={{ textAlign: "center", marginTop: 2 }}>
        <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: "monospace", lineHeight: 1 }}>
          {info?.note ?? "—"}{info?.latin && ` (${info.latin})`}
        </div>
        <div style={{ color: "#444", fontSize: 10, fontFamily: "monospace", marginTop: 2 }}>
          {info?.hz ?? "—"} Hz
          <span style={{ color: inTune ? "#00ff88" : "#ff5555" }}>
            {" "}{cents > 0 ? "+" : ""}{cents}c
          </span>
        </div>
        {inTune && pitch > 50 && <div style={{ color: "#00ff8877", fontSize: 9, marginTop: 2 }}>afinado</div>}
      </div>
    </div>
  );
}

function PitchDiff({ localPitch, remotePitch }) {
  const hasData = localPitch > 50 && remotePitch > 50;
  const diffCents = hasData ? Math.round(1200 * Math.log2(localPitch / remotePitch)) : 0;
  const inSync = Math.abs(diffCents) < 10;
  return (
    <div style={{ background: "#0a0a14", border: "1px solid " + (hasData ? (inSync ? "#00ff8833" : "#ff444433") : "#222"),
      borderRadius: 8, padding: "8px 12px", textAlign: "center", minWidth: 70 }}>
      <div style={{ color: "#444", fontSize: 9, letterSpacing: 2, marginBottom: 3 }}>DIFF</div>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: hasData ? (inSync ? "#00ff88" : "#ff5555") : "#333" }}>
        {hasData ? `${diffCents > 0 ? "+" : ""}${diffCents}c` : "—"}
      </div>
      <div style={{ color: hasData ? (inSync ? "#00ff8866" : "#ff444466") : "#222", fontSize: 9, marginTop: 3 }}>
        {hasData ? (inSync ? "sync" : Math.abs(diffCents) > 50 ? "lejos" : "leve") : "esperando"}
      </div>
    </div>
  );
}

function Spectrum({ data, color, label, scaleNotes }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || !data.length) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Grid lines
    for (let i = 1; i < 4; i++) {
      const y = H * (1 - i / 4);
      ctx.strokeStyle = "#1a1a2e";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    const barW = W / data.length;
    // Filled area
    ctx.beginPath();
    ctx.moveTo(0, H);
    data.forEach((v, i) => {
      ctx.lineTo(i * barW + barW / 2, H - Math.min(1, Math.max(0, v)) * H);
    });
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color + "20";
    ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * barW + barW / 2;
      const y = H - Math.min(1, Math.max(0, v)) * H;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [data, color]);

  return (
    <div style={{ flex: 1 }}>
      <div style={{ color: "#444", fontSize: 9, letterSpacing: 2, marginBottom: 4 }}>
        {label.toUpperCase()} — FFT
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <canvas ref={canvasRef} width={512} height={200}
          style={{ width: "100%", height: "100%", borderRadius: 8,
            border: "1px solid " + color + "22", display: "block" }}/>
        <NoteMarkers scaleNotes={scaleNotes} height="100%" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, position: "relative", height: 12 }}>
        {[50, 100, 200, 400, 600, 800, 1000, 1500, 2000, 2500].map(hz => {
          const pos = hzToLogPos(hz);
          if (pos < 0 || pos > 1) return null;
          return (
            <span key={hz} style={{ position: "absolute", left: `${pos * 100}%`, transform: "translateX(-50%)",
              color: "#333", fontSize: 8, fontFamily: "monospace" }}>
              {hz >= 1000 ? `${(hz/1000).toFixed(hz % 1000 ? 1 : 0)}k` : hz}
            </span>
          );
        })}
        <span style={{ visibility: "hidden", fontSize: 8 }}>.</span>
      </div>
    </div>
  );
}

function EnergyBars({ mel, color }) {
  if (!mel || !Array.isArray(mel) || mel.length < 6) return null;
  const t = Math.floor(mel.length / 3);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const bands = [
    { name: "G", val: avg(mel.slice(0, t)),     col: "#4466ff" },
    { name: "M", val: avg(mel.slice(t, t * 2)), col: color },
    { name: "A", val: avg(mel.slice(t * 2)),    col: "#ff6644" },
  ];
  return (
    <div style={{ display: "flex", gap: 6, flex: 1 }}>
      {bands.map(({ name, val, col }) => (
        <div key={name} style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
            <span style={{ color: "#444", fontSize: 8 }}>{name}</span>
            <span style={{ color: col, fontSize: 8, fontFamily: "monospace" }}>{(val * 100).toFixed(0)}%</span>
          </div>
          <div style={{ background: "#111", borderRadius: 3, height: 4 }}>
            <div style={{ background: col, height: "100%", borderRadius: 3,
              width: Math.min(100, val * 100) + "%", transition: "width 80ms ease-out" }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Main ---

export default function ViolinSession() {
  const [local, setLocal] = useState({ pitch: 0, mel: [], fft: [], history: [] });
  const [remote, setRemote] = useState({ pitch: 0, mel: [], fft: [], history: [] });
  const [connected, setConnected] = useState({ server: false, local: false });
  const [scaleIdx, setScaleIdx] = useState(1);
  const connRef = useRef(null);
  const localWsRef = useRef(null);
  const localClientId = useRef(`${SESSION_ID}-audio`);  // updated when browser mode activates

  const scaleDef = SCALE_DEFS[scaleIdx];
  const scaleNotes = scaleDef.get ? scaleDef.get() : (scaleDef.notes || []);

  // --- SpacetimeDB connection ---
  useEffect(() => {
    let conn;
    try {
      conn = DbConnection.builder()
        .withUri(STDB_URL)
        .withDatabaseName("violin-session")
        .onConnect((connection) => {
          setConnected(c => ({ ...c, server: true }));

          const handleFrame = (row) => {
            if (row.bufName !== "mid") return;
            if (row.clientId === localClientId.current) return;
            const mel = Array.from(row.mel);
            const fft = row.fft ? Array.from(row.fft) : [];
            setRemote(prev => ({
              pitch:   row.pitch,
              mel:     mel,
              fft:     fft,
              history: [...prev.history.slice(-(WATERFALL_ROWS - 1)), mel],
            }));
          };

          connection.db.audio_frame.onInsert((_ctx, row) => handleFrame(row));
          connection.db.audio_frame.onUpdate((_ctx, _old, row) => handleFrame(row));

          connection.subscriptionBuilder()
            .onApplied(() => console.log("[stdb] subscription applied"))
            .onError((_ctx, err) => console.error("[stdb] subscription error:", err))
            .subscribe(`SELECT * FROM audio_frame WHERE session_id = '${SESSION_ID}'`);
        })
        .onConnectError((_ctx, error) => {
          console.error("[stdb] Connection error:", error);
          setConnected(c => ({ ...c, server: false }));
        })
        .onDisconnect(() => {
          console.warn("[stdb] Disconnected");
          setConnected(c => ({ ...c, server: false }));
        })
        .build();

      connRef.current = conn;
    } catch (e) {
      console.error("[stdb] Failed to initialize:", e);
    }

    return () => { try { conn?.disconnect(); } catch(e) {} };
  }, []);

  // --- Local audio: try WebSocket first, fallback to browser mic ---
  const handleAudioFrame = useCallback((msg) => {
    if (msg.type === "pitch") {
      setLocal(prev => {
        const mel = msg.mel || prev.mel;
        const fft = msg.fft || prev.fft;
        return {
          pitch: msg.pitch, mel, fft,
          history: msg.mel ? [...prev.history.slice(-(WATERFALL_ROWS - 1)), mel] : prev.history,
        };
      });
    }
  }, []);

  useEffect(() => {
    const url = `${import.meta.env.VITE_LOCAL_WS || "ws://localhost:8001"}`;
    let stopBrowser = null;
    let wsTimeout = null;
    let wsConnected = false;
    let cancelled = false;

    function startBrowserFallback() {
      if (cancelled || wsConnected) return;
      // Unique ID per device so two browsers don't filter each other out
      const browserId = `${SESSION_ID}-browser-${Math.random().toString(36).slice(2, 8)}`;
      console.log("[audio] No local WS — using browser mic, id:", browserId);
      localClientId.current = browserId;
      setConnected(c => ({ ...c, local: true, mode: "browser" }));
      const serverUrl = `ws://${STDB_HOST}:8000/audio`;
      stopBrowser = startBrowserAudio(handleAudioFrame, serverUrl, SESSION_ID, browserId);
    }

    function connect() {
      if (cancelled) return;
      try {
        const ws = new WebSocket(url);
        localWsRef.current = ws;
        ws.onopen = () => {
          wsConnected = true;
          if (wsTimeout) clearTimeout(wsTimeout);
          setConnected(c => ({ ...c, local: true, mode: "ws" }));
        };
        ws.onclose = () => {
          if (cancelled) return;
          setConnected(c => ({ ...c, local: false }));
          if (wsConnected) {
            wsConnected = false;
            setTimeout(connect, 2000);
          }
        };
        ws.onerror = () => {};
        ws.onmessage = (event) => {
          try { handleAudioFrame(JSON.parse(event.data)); } catch(e) {}
        };
      } catch(e) {
        startBrowserFallback();
      }
    }

    // Try WS first, fallback to browser mic after 3s
    connect();
    wsTimeout = setTimeout(() => {
      if (!wsConnected && !cancelled) startBrowserFallback();
    }, 3000);

    return () => {
      cancelled = true;
      if (wsTimeout) clearTimeout(wsTimeout);
      localWsRef.current?.close();
      if (stopBrowser) stopBrowser();
    };
  }, [handleAudioFrame]);

  const LOC = "#7c6fff";
  const REM = "#ff6b6b";

  return (
    <div style={{ background: "#080810", height: "100vh", padding: 12, display: "flex", flexDirection: "column",
      fontFamily: "Inter, system-ui, sans-serif", color: "#fff", boxSizing: "border-box", overflow: "hidden" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Violin Session</span>
          <span style={{ color: "#333", fontSize: 10, fontFamily: "monospace" }}>{SESSION_ID}</span>
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 10, fontFamily: "monospace", alignItems: "center" }}>
          <select value={scaleIdx} onChange={e => setScaleIdx(Number(e.target.value))}
            style={{ background: "#111", color: "#aaa", border: "1px solid #333", borderRadius: 4,
              padding: "2px 6px", fontSize: 10, fontFamily: "monospace" }}>
            {SCALE_DEFS.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
          </select>
          <span style={{ color: connected.server ? "#00ff88" : "#ff4444" }}>
            {connected.server ? "stdb" : "stdb off"}
          </span>
          <span style={{ color: connected.local ? "#00aaff" : "#ff4444" }}>
            {connected.local ? (connected.mode === "browser" ? "mic" : "local") : "local off"}
          </span>
        </div>
      </div>

      {/* Tuners row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexShrink: 0 }}>
        <Tuner pitch={local.pitch} label="Vos" color={LOC} />
        <PitchDiff localPitch={local.pitch} remotePitch={remote.pitch} />
        <Tuner pitch={remote.pitch} label="Otro musico" color={REM} />
      </div>

      {/* FFT — takes remaining space */}
      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0, marginBottom: 8 }}>
        <Spectrum data={local.fft} color={LOC} label="Vos" scaleNotes={scaleNotes} />
        <Spectrum data={remote.fft} color={REM} label="Otro musico" scaleNotes={scaleNotes} />
      </div>

      {/* Energy bars — compact row */}
      <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#444", fontSize: 8, letterSpacing: 1, marginBottom: 3 }}>VOS</div>
          <EnergyBars mel={local.mel} color={LOC} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#444", fontSize: 8, letterSpacing: 1, marginBottom: 3 }}>OTRO</div>
          <EnergyBars mel={remote.mel} color={REM} />
        </div>
      </div>
    </div>
  );
}
