"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_CONFIG, KNOBS, renderEchogram, type EchogramConfig, type SoundingPoint } from "@/lib/echogram/render";
import saved from "@/lib/echogram/config.json";
import { CETUS_REHEARSAL } from "@/lib/echogram/sample";

const CETUS = CETUS_REHEARSAL;

const STORE = "watchseal-echogram-saves";

function preview(replayed: number): SoundingPoint[] {
  return CETUS.map((p, i) =>
    i === 0 || i <= replayed
      ? { ...p, current: i === replayed }
      : { version: p.version, withMem: null, without: null },
  );
}

export default function EchogramLab() {
  const [cfg, setCfg] = useState<EchogramConfig>({ ...DEFAULT_CONFIG, ...(saved as Partial<EchogramConfig>) });
  const [replayed, setReplayed] = useState(6);
  const [rail, setRail] = useState<EchogramConfig[]>([]);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) setRail(JSON.parse(raw));
    } catch {
      /* storage unavailable: the rail just starts empty */
    }
  }, []);

  const points = useMemo(() => preview(replayed), [replayed]);
  const { svg } = useMemo(() => renderEchogram(cfg, points), [cfg, points]);
  const set = <K extends keyof EchogramConfig>(k: K, v: EchogramConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  async function save() {
    const json = JSON.stringify(cfg, null, 2);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      /* clipboard blocked: the file write below still keeps it */
    }
    const res = await fetch("/api/lab/echogram", { method: "POST", headers: { "content-type": "application/json" }, body: json });
    const body = await res.json();
    setSavedPath(body.ok ? `${body.path} (and clipboard)` : `clipboard only: ${body.error}`);
    const next = [cfg, ...rail.filter((r) => JSON.stringify(r) !== JSON.stringify(cfg))].slice(0, 8);
    setRail(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="lab">
      <header className="lab-head">
        <h1>Echogram lab</h1>
        <div className="lab-tabs" role="tablist">
          {(["echogram", "survey"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={cfg.mode === m} className={cfg.mode === m ? "on" : ""} onClick={() => set("mode", m)}>
              {m === "echogram" ? "Echo-sounder paper" : "Survey sheet"}
            </button>
          ))}
        </div>
        <p className="muted">Click the paper for a new one, knobs to tweak, Save to keep.</p>
      </header>

      <div className="lab-body">
        <div className="lab-canvas-wrap">
          <button className="lab-canvas" onClick={() => set("seed", Math.floor(Math.random() * 2 ** 31))} aria-label="New variation" dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="lab-meta">
            <span>
              Seed <code>{cfg.seed}</code>
            </span>
            <label>
              Replayed to v{CETUS[replayed].version}
              <input type="range" min={0} max={CETUS.length - 1} value={replayed} onChange={(e) => setReplayed(Number(e.target.value))} />
            </label>
            <button className="btn primary" onClick={save}>
              Save
            </button>
            {savedPath && <span className="muted">Saved to {savedPath}</span>}
          </div>
          {rail.length > 0 && (
            <div className="lab-rail" aria-label="Saved configs">
              {rail.map((r, i) => (
                <button key={i} onClick={() => setCfg(r)} title={`seed ${r.seed}, ${r.mode}, ${r.palette}`} dangerouslySetInnerHTML={{ __html: renderEchogram(r, points).svg }} />
              ))}
            </div>
          )}
        </div>

        <aside className="lab-panel">
          <label>
            Palette
            <select value={cfg.palette} onChange={(e) => set("palette", e.target.value as EchogramConfig["palette"])}>
              <option value="ice">Ice (app palette)</option>
              <option value="dry">Dry paper, carbon black</option>
              <option value="wet">Wet paper, iodine brown</option>
            </select>
          </label>
          {cfg.mode === "echogram" && (
            <label className="check">
              <input type="checkbox" checked={cfg.whiteLine} onChange={(e) => set("whiteLine", e.target.checked)} /> White line
            </label>
          )}
          {KNOBS.filter((k) => k.modes.includes(cfg.mode)).map((k) => (
            <label key={k.key}>
              <span className="knob-row">
                {k.label}
                <output>{cfg[k.key]}</output>
              </span>
              <input type="range" min={k.min} max={k.max} step={k.step} value={cfg[k.key]} onChange={(e) => set(k.key, Number(e.target.value))} />
            </label>
          ))}
          <button className="btn ghost" onClick={() => setCfg({ ...DEFAULT_CONFIG, mode: cfg.mode })}>
            Reset knobs
          </button>
        </aside>
      </div>
    </div>
  );
}
