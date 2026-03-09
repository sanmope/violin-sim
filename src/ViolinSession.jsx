import { useState, useEffect, useRef } from "react";


const N_MELS = 64;
const WATERFALL_ROWS = 80;
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const SESSION_ID = import.meta.env.VITE_SESSION_ID || "mi-sesion-123";
const CLIENT_ID  = "react-client-1";

function hzToNoteInfo(hz) {
  if (!hz || hz < 50) return null;
  const semitones = 12 * Math.log2(hz / 440) + 69;
  const noteIdx = ((Math.round(semitones) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(semitones) / 12) - 1;
  const cents = Math.round((semitones - Math.round(semitones)) * 100);
  return { note: `${NOTE_NAMES[noteIdx]}${octave}`, cents, hz: hz.toFixed(1) };
}

function melToColor(v) {
  const r = Math.round(Math.min(255, v * 3 * 255));
  const g = Math.round(Math.min(255, Math.max(0, (v * 3 - 0.5) * 255)));
  const b = Math.round(Math.max(0, (1 - v * 2) * 255));
  return `rgb(${r},${g},${b})`;
}

function Tuner({ pitch, label, color }) {
  const info = hzToNoteInfo(pitch);
  const cents = info?.cents ?? 0;
  const angle = Math.max(-45, Math.min(45, cents * 0.9));
  const inTune = Math.abs(cents) < 5;
  return (
    <div style={{ background: "#0f0f1a", border: `1px solid ${color}33`, borderRadius: 12, padding: "12px 16px", flex: 1 }}>
      <div style={{ color: "#555", fontSize: 9, letterSpacing: 2, marginBottom: 4 }}>{label.toUpperCase()}</div>
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
        <div style={{ color, fontSize: 24, fontWeight: 700, fontFamily: "monospace", lineHeight: 1 }}>
          {info?.note ?? "—"}
        </div>
        <div style={{ cor: "#444", fontSize: 10, fontFamily: "monospace", marginTop: 3 }}>
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
  if (!localPitch || !remotePitch || localPitch < 50 || remotePitch < 50) return null;
  const diffCents = Math.round(1200 * Math.log2(localPitch / remotePitch));
  const inSync = Math.abs(diffCents) < 10;
  return (
    <div style={{ background: "#0a0a14", border: "1px solid " + (inSync ? "#00ff8833" : "#ff444433"),
      borderRadius: 8, padding: "8px 12px", textAlign: "center", minWidth: 70 }}>
      <div style={{ color: "#444", fontSize: 9, letterSpacing: 2, marginBottom: 3 }}>DIFF</div>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: inSync ? "#00ff88" : "#ff5555" }}>
        {diffCents > 0 ? "+" : ""}{diffCents}c
      </div>
      <div style={{ color: inSync ? "#00ff8866" : "#ff444466", fontSize: 9, marginTop: 3 }}>
        {inSync ? "sync" : Math.abs(diffCents) > 50 ? "lejos" : "leve"}
      </div>
    </div>
  );
}

function Waterfall({ melHistory, color, label }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !melHistory.length) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const rows = melHistory.slice(-WATERFALL_ROWS);
    const rowH = H / WATERFALL_ROWS;
    const colW = W / N_MELS;
    rows.forEach((row, ri) => {
      row.forEach((val, bi) => {
        ctx.fillStyle = melToColor(Math.min(1, Math.max(0, val)));
        ctx.fillRect(bi * colW, ri * rowH, colW + 0.5, rowH + 0.5);
      });
    });
  }, [melHistory]);
  return (
    <div style={{ flex: 1 }}>
      <div style={{ color: "#444", fontSize: 9, letterSpacing: 2, marginBottom: 4 }}>
        {label.toUpperCase()} — ESPECTROGRAMA
      </div>
      <canvas ref={canvasRef} width={256} height={140}
        style={{ width: "100%", height: 140, borderRadius: 8,
          border: "1px solid " + color + "22", imageRendering: "pixelated", display: "block" }}/>
      <div style={{ display: "flex", justifyContent: "space-beeen", marginTop: 2 }}>
        <span style={{ color: "#333", fontSize: 9 }}>196Hz</span>
        <span style={{ color: "#333", fontSize: 9 }}>3520Hz</span>
      </div>
    </div>
  );
}

function EnergyBars({ mel, color, label }) {
  try {
    if (!mel || !Array.isArray(mel) || mel.length < 6) return null;
    const t = Math.floor(mel.length / 3);
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const bands = [
      { name: "Graves", val: avg(mel.slice(0, t)),     col: "#4466ff" },
      { name: "Medios", val: avg(mel.slice(t, t * 2)), col: color },
      { name: "Agudos", val: avg(mel.slice(t * 2)),    col: "#ff6644" },
    ];
    return (
      <div style={{ flex: 1 }}>
        <div style={{ color: "#444", fontSize: 9, letterSpacing: 2, marginBottom: 4 }}>
          {label.toUpperCase()} — ENERGIA
        </div>
        {bands.map(({ name, val, col }) => (
          <div key={name} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ color: "#555", fontSize: 10 }}>{name}</span>
              <span style={{ color: col, fontSize: 10, fontFamily: "monospace" }}>{(val * 100).toFixed(0)}%</span>
            </div>
            <div style={{ background: "#111", borderRadius: 4, height: 5 }}>
              <div style={{ background: col, height: "100%", borderRadius: 4,
                width: Math.min(100, val * 100) + "%",
                transition: "width 80ms ease-out" }}/>
            </div>
          </div>
        ))}
      </div>
    );
  } catch(e) { return null; }
}

export default function ViolinSession() {
  const [localPitch, setLocalPitch] = useState(0);
  const [remote, setRemote] = useState({ pitch: 0, mel: [], history: [] });
  const [connected, setConnected] = useState({ server: false, local: false });
  const [latency, setLatency] = useState(0);
  const serverWsRef = useRef(null);
  const localWsRef  = useRef(null);
  const lastTsRef   = useRef(null);

  useEffect(() => {
    const url = `ws://${window.location.host}/react?session_id=${SESSION_ID}&client_id=${CLIENT_ID}`;
    function connect() {
      const ws = new WebSocket(url);
      
      serverWsRef.current = ws;
      ws.onopen  = () => setConnected(c => ({ ...c, server: true }));
      ws.onclose = () => { setConnected(c => ({ ...c, server: false })); setTimeout(connect, 2000); };
      ws.onmessage = (event) => {
        try {
          if (typeof event.data !== "string" || event.data === "ping") return;
          const frame = JSON.parse(event.data);
          if (!frame || frame.buf !== "mid") return;
          const now = Date.now();
          if (lastTsRef.current) setLatency(now - lastTsRef.current);
          lastTsRef.current = now;
          setRemote(prev => ({
            pitch:   frame.pitch,
            mel:     frame.mel,
            history: [...prev.history.slice(-(WATERFALL_ROWS - 1)), frame.mel],
          }));
        } catch(e) { console.warn("Error parsing frame:", e); }
      };
    }
    connect();
    return () => serverWsRef.current?.close();
  }, []);

  useEffect(() => {
    const url = `${import.meta.env.VITE_LOCAL_WS || "ws://localhost:8001"}`;
    function connect() {
      const ws = new WebSocket(url);
      localWsRef.current = ws;
      ws.onopen  = () => setConnected(c => ({ ...c, local: true }));
      ws.onclose = () => { setConnected(c => ({ ...c, local: false })); setTimeout(connect, 2000); };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "pitch") setLocalPitch(msg.pitch);
        } catch(e) {}
      };
    }
    connect();
    return () => localWsRef.current?.close();
  }, []);

  const LOC = "#7c6fff";
  const REM = "#ff6b6b";

  return (
    <div style={{ background: "#080810", minHeight: "100vh", padding: 16,
      fontFamily: "Inter, system-ui, sans-serif", color: "#fff", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>Violin Session</span>
          <span style={{ color: "#333", fontSize: 10, fontFamily: "monospace" }}>{SESSION_ID}</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 10, fontFamily: "monospace" }}>
          <span style={{ color: connected.server ? "#00ff88" : "#ff4444" }}>
            {connected.server ? "servidor OK" : "servidor offline"}
          </span>
          <span style={{ color: connected.local ? "#00aaff" : "#ff4444" }}>
            {connected.local ? "local OK" : "local offline"}
          </span>
          {latency > 0 && <span style={{ color: "#555" }}>{latency}ms</span>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
        <Tuner pitch={localPitch}   label="Vos"         color={LOC} />
        <PitchDiff localPitch={localPitch} remotePitch={remote.pitch} />
        <Tuner pitch={remote.pitch} label="Otro musico" color={REM} />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <Waterfall melHistory={[]}             color={LOC} label="Vos (mel en servidor)" />
        <Waterfall melHistory={remote.history} color={REM} label="Otro musico" />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <EnergyBars mel={remote.mel} color={REM} label="Otro musico" />
      </div>
      {!connected.server && !connected.local && (
        <div style={{ marginTop: 20, color: "#444", fontSize: 11, textAlign: "center" }}>
          Esperando conexion — corré pipeline_server.py y audio_client.py
        </div>
      )}
    </div>
  );
}
