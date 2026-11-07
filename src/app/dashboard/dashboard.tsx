"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Verdict } from "@/lib/agent/verdict";
import type { RiskLevel } from "@/lib/analysis/risk";
import type { Signal } from "@/lib/analysis/signals";
import type { Memory, TriageLabel } from "@/lib/memory/format";
import type { MemoryLogEntry } from "@/lib/memory/store";
import type { Counters } from "@/lib/metrics";
import { renderEchogram, type EchogramConfig, type SoundingPoint } from "@/lib/echogram/render";
import echogramConfig from "@/lib/echogram/config.json";
import type { Alert, WatchedProtocol } from "@/lib/state";

type WatchRow = Omit<WatchedProtocol, "versions"> & { versionCount: number; latest: number | null; remaining: number };
interface View {
  watchlist: WatchRow[];
  alerts: Alert[];
  memoryLog: MemoryLogEntry[];
  counters: Counters;
  activity: { step: string; at: string } | null;
  memoryBackend: "walrus" | "mock";
}
interface Status {
  chain: { mode: "tatum" | "fixture"; transport: string | null; host: string | null };
  memory: { backend: "walrus" | "mock"; network: string; credentials: string; namespace: string; healthy: boolean; detail: string; pending: number; delegatePublicKey: string | null };
  agent: { engine: "claude" | "fallback"; model: string };
  counters: Counters;
}

const LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];
const ZONE: Record<RiskLevel, string> = { low: "Surface", medium: "Shallows", high: "Deep water", critical: "Abyss" };
const PRESETS = [
  { name: "Cetus CLMM", id: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", start: 9 },
  { name: "DeepBook V3", id: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809", start: 5 },
];

const short = (s?: string | null, n = 6) => (!s ? "?" : s.length > n * 2 + 3 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);
const fmtDate = (ms?: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "unknown date");
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function splitMemory(text: string) {
  const m = text.match(/^((?:\[[^\]]*\])+)\s*(.*)$/s);
  if (!m) return { tags: [] as string[], body: text };
  const tags = [...m[1].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]).filter((t) => t !== "watchseal");
  return { tags, body: m[2] };
}

/** Display-only: 0x + 64 hex becomes 0x1234…cdef. */
const shortAddrs = (t: string) => t.replace(/0x[0-9a-fA-F]{40,64}/g, (a) => `${a.slice(0, 6)}…${a.slice(-4)}`);

function tagValue(tags: string[], key: string) {
  return tags.find((t) => t.startsWith(`${key}:`))?.slice(key.length + 1);
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "Action failed.");
  return json as { result: unknown; state: View };
}

export default function Dashboard() {
  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      setView(await r.json());
    } catch {
      /* keep last view */
    }
  }, []);
  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      /* keep last status */
    }
  }, []);

  const working = !!busy || !!view?.activity;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(refresh, 900);
    return () => clearInterval(t);
  }, [working, refresh]);

  useEffect(() => {
    refresh();
    refreshStatus();
    const a = setInterval(refresh, 2500);
    const b = setInterval(refreshStatus, 15000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refresh, refreshStatus]);

  const act = useCallback(
    async (key: string, body: Record<string, unknown>, after?: (result: unknown) => void) => {
      setBusy(key);
      setError(null);
      try {
        const { result, state } = await post(body);
        setView(state);
        after?.(result);
        refreshStatus();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refreshStatus],
  );

  const alerts = view?.alerts ?? [];
  // The protocol you are working on: the one you just added, pulled the next upgrade for, or selected an alert from.
  const [focus, setFocus] = useState<string | null>(null);
  const current = useMemo(
    () => alerts.find((a) => a.id === selected) ?? (focus ? alerts.find((a) => a.slug === focus) : alerts[0]) ?? null,
    [alerts, selected, focus],
  );
  const select = useCallback(
    (id: string) => {
      setSelected(id);
      const a = alerts.find((x) => x.id === id);
      if (a) setFocus(a.slug);
    },
    [alerts],
  );
  const focusOn = useCallback((slug: string, alertId?: string) => {
    setFocus(slug);
    setSelected(alertId ?? null);
  }, []);
  const counters = status?.counters ?? view?.counters;
  const focusSlug = current?.slug ?? focus;
  const timelineFor = view?.watchlist.find((w) => w.slug === focusSlug) ?? view?.watchlist[0] ?? null;
  const [help, setHelp] = useState(false);

  // Keyboard shortcuts for recording the demo. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === "escape") return setHelp(false);
      if (e.key === "?") return setHelp((h) => !h);
      if (busy) return;
      const proto = view?.watchlist.find((w) => w.slug === focusSlug && w.mode === "replay") ?? view?.watchlist.find((w) => w.mode === "replay");
      const labels: Record<string, TriageLabel> = { e: "expected", s: "suspicious", f: "false-positive" };
      if (key === "n" && proto && proto.remaining > 0) {
        act(`next:${proto.slug}`, { op: "next", slug: proto.slug }, (a) => focusOn(proto.slug, (a as Alert).id));
      } else if (labels[key] && current) {
        act(`triage:${labels[key]}`, { op: "triage", alertId: current.id, label: labels[key] });
      } else if (key === "c" && current) {
        act("compare", { op: "compare", alertId: current.id });
      } else if ((key === "j" || key === "k") && alerts.length) {
        const i = Math.max(0, alerts.findIndex((a) => a.id === current?.id));
        const next = alerts[Math.min(alerts.length - 1, Math.max(0, i + (key === "j" ? 1 : -1)))];
        select(next.id);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, alerts, busy, current, view, focusSlug, focusOn, select]);

  return (
    <div className="app">
      <TopBar status={status} counters={counters} onHelp={() => setHelp(true)} />
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {error && (
        <div className="error" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <main className="grid">
        <section className="col left" aria-label="Watchlist and alerts">
          <Watchlist view={view} busy={busy} act={act} onFocus={focusOn} />
          <Feed alerts={alerts} current={current} onSelect={select} />
        </section>
        <section className="col center" aria-label="Alert detail">
          {(busy || view?.activity) && <Activity activity={view?.activity ?? null} />}
          {timelineFor && <Soundings protocol={timelineFor} alerts={alerts} current={current} onSelect={select} />}
          {current ? (
            <AlertDetail alert={current} busy={busy} act={act} memoryLog={view?.memoryLog ?? []} backend={view?.memoryBackend ?? "mock"} />
          ) : (
            <EmptyDetail hasProtocols={!!view?.watchlist.length} />
          )}
        </section>
        <section className="col right" aria-label="Memory">
          <Rules view={view} busy={busy} act={act} />
          <MemoryLog log={view?.memoryLog ?? []} status={status} slug={current?.slug ?? view?.watchlist[0]?.slug ?? null} />
        </section>
      </main>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["N", "Next upgrade (replay)"],
  ["E", "Label expected"],
  ["S", "Label suspicious"],
  ["F", "Label false positive"],
  ["C", "Compare without memory"],
  ["J / K", "Next / previous alert"],
  ["?", "Show or hide this list"],
];

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-backdrop" onClick={onClose}>
      <div className="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Keyboard shortcuts</h2>
          <button className="btn ghost small" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <dl>
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function TopBar({ status, counters, onHelp }: { status: Status | null; counters?: Counters; onHelp: () => void }) {
  const chainOk = status?.chain.mode === "tatum";
  const memOk = status?.memory.backend === "walrus" && status.memory.healthy;
  const agentOk = status?.agent.engine === "claude";
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="WatchSeal home">
        <img src="/seal.svg" alt="" width={34} height={34} />
        <div>
          <h1>WatchSeal</h1>
          <p>Sui upgrade watch that learns your triage</p>
        </div>
      </a>
      <div className="backends">
        <Backend ok={chainOk} label="Chain" value={!status ? "…" : chainOk ? `Tatum Sui gRPC (${status.chain.transport})` : "Recorded fixtures (offline)"} />
        <Backend
          ok={memOk}
          label="Memory"
          value={!status ? "…" : status.memory.backend === "walrus" ? `Walrus Mainnet${status.memory.healthy ? "" : " (unreachable)"}` : "Offline mock"}
          extra={status?.memory.pending ? `${status.memory.pending} writing` : undefined}
        />
        <Backend ok={agentOk} label="Agent" value={!status ? "…" : agentOk ? `Claude ${status.agent.model}` : "Fallback engine"} />
      </div>
      <dl className="counters">
        <Counter k="Tatum gRPC calls" v={counters?.tatumCalls} />
        <Counter k="Archival reads" v={counters?.archivalCalls} />
        <Counter k="Memories written" v={counters?.memoryStored} />
        <Counter k="Recalls" v={counters?.memoryRecalls} />
      </dl>
      <button className="kbd-hint" onClick={onHelp} aria-label="Keyboard shortcuts">
        <kbd>?</kbd>
      </button>
    </header>
  );
}

function Backend({ ok, label, value, extra }: { ok: boolean; label: string; value: string; extra?: string }) {
  return (
    <div className={`backend ${ok ? "ok" : "degraded"}`}>
      <span className="dot" aria-hidden />
      <span className="backend-label">{label}</span>
      <span className="backend-value">{value}</span>
      {extra && <span className="backend-extra">{extra}</span>}
    </div>
  );
}

function Counter({ k, v }: { k: string; v?: number }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v ?? "–"}</dd>
    </div>
  );
}

type Act = (key: string, body: Record<string, unknown>, after?: (result: unknown) => void) => Promise<void>;

function Watchlist({ view, busy, act, onFocus }: { view: View | null; busy: string | null; act: Act; onFocus: (slug: string, alertId?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ originalId: "", name: "", mode: "replay", startVersion: "" });
  const rows = view?.watchlist ?? [];
  const showForm = open || (view !== null && rows.length === 0);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Watchlist</h2>
        <div className="row-actions">
          {rows.some((r) => r.mode === "live") && (
            <button className="btn ghost" disabled={!!busy} onClick={() => act("scan", { op: "scan" }, (r) => { const created = r as Alert[]; if (created[0]) onFocus(created[0].slug, created[0].id); })}>
              {busy === "scan" ? "Scanning…" : "Scan live"}
            </button>
          )}
          <button className="btn ghost" onClick={() => setOpen(!open)} aria-expanded={showForm}>
            {showForm ? "Close" : "Add protocol"}
          </button>
        </div>
      </div>
      {showForm && (
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            act("add", { op: "add", ...form }, (p) => {
              setOpen(false);
              onFocus((p as WatchRow).slug);
            });
          }}
        >
          <div className="presets">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                className="chip-btn"
                onClick={() => setForm({ originalId: p.id, name: p.name, mode: "replay", startVersion: String(p.start) })}
              >
                {p.name} from v{p.start}
              </button>
            ))}
          </div>
          <label>
            Package ID
            <input className="mono" value={form.originalId} onChange={(e) => setForm({ ...form, originalId: e.target.value })} placeholder="0x…" spellCheck={false} required />
          </label>
          <div className="form-row">
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Optional" />
            </label>
            <label>
              Start at
              <input value={form.startVersion} onChange={(e) => setForm({ ...form, startVersion: e.target.value })} placeholder="latest" inputMode="numeric" />
            </label>
          </div>
          <fieldset className="segmented">
            <legend>Mode</legend>
            {(["replay", "live"] as const).map((m) => (
              <label key={m} className={form.mode === m ? "on" : ""}>
                <input type="radio" name="mode" value={m} checked={form.mode === m} onChange={() => setForm({ ...form, mode: m })} />
                {m === "replay" ? "Replay history" : "Watch live"}
              </label>
            ))}
          </fieldset>
          <button className="btn primary" disabled={!!busy}>
            {busy === "add" ? "Reading package via Tatum…" : "Start watching"}
          </button>
        </form>
      )}
      <ul className="watch-rows">
        {rows.map((r) => (
          <li key={r.slug}>
            <div className="watch-main">
              <strong>{r.name}</strong>
              <span className="muted">
                v{r.cursor} of v{r.latest}, {r.mode === "replay" ? "replay" : "live"}
              </span>
            </div>
            <div className="row-actions">
              {r.mode === "replay" && (
                <button
                  className="btn primary"
                  title="Shortcut: N"
                  disabled={!!busy || r.remaining === 0}
                  onClick={() => act(`next:${r.slug}`, { op: "next", slug: r.slug }, (a) => onFocus(r.slug, (a as Alert).id))}
                >
                  {busy === `next:${r.slug}` ? "Diffing and recalling…" : r.remaining === 0 ? "Caught up" : `Next upgrade (v${r.cursor + 1})`}
                </button>
              )}
              <button className="btn ghost small" disabled={!!busy} onClick={() => act(`reset:${r.slug}`, { op: "reset", slug: r.slug })} title="Rewind to the start version and clear its alerts. Memories stay on Walrus.">
                Rewind
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RiskPill({ risk, faint }: { risk: RiskLevel; faint?: boolean }) {
  return <span className={`risk risk-${risk}${faint ? " faint" : ""}`}>{risk}</span>;
}

/** The depth gauge in miniature: one cell per level, filled down to the risk. */
function Sounding({ risk }: { risk: RiskLevel }) {
  const depth = LEVELS.indexOf(risk);
  return (
    <span className={`sounding sounding-${risk}`} aria-label={`${risk} risk`}>
      <span className="cells" aria-hidden>
        {LEVELS.map((l, i) => (
          <i key={l} className={i <= depth ? `on zone-${l}` : ""} />
        ))}
      </span>
      <span className="sounding-label">{risk}</span>
    </span>
  );
}

function Activity({ activity }: { activity: { step: string; at: string } | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = activity ? Math.max(0, Math.round((Date.now() - Date.parse(activity.at)) / 1000)) : 0;
  return (
    <div className="activity" role="status" aria-live="polite">
      <span className="sonar" aria-hidden />
      <span>{activity?.step ?? "Working"}</span>
      {secs > 2 && <span className="muted">{secs}s</span>}
    </div>
  );
}

function Feed({ alerts, current, onSelect }: { alerts: Alert[]; current: Alert | null; onSelect: (id: string) => void }) {
  return (
    <div className="panel feed">
      <div className="panel-head">
        <h2>Alerts</h2>
        <span className="muted">{alerts.length}</span>
      </div>
      {alerts.length === 0 ? (
        <p className="empty">Alerts appear here as upgrades are found.</p>
      ) : (
        <ul>
          {alerts.map((a) => (
            <li key={a.id}>
              <button className={`feed-item${current?.id === a.id ? " active" : ""}`} onClick={() => onSelect(a.id)}>
                <Sounding risk={a.verdict.risk} />
                <span className="feed-text">
                  <span className="feed-title">
                    {a.protocolName} {a.type === "cap" ? "UpgradeCap" : `v${a.version}`}
                  </span>
                  <span className="muted">{a.diffSummary}</span>
                </span>
                {a.triage && <span className={`label-badge label-${a.triage.label}`}>{a.triage.label}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyDetail({ hasProtocols }: { hasProtocols: boolean }) {
  return (
    <div className="panel empty-detail">
      <img className="waterline" src="/waterline.jpg" alt="" width={1400} height={317} />
      <h2>{hasProtocols ? "Pull the next upgrade" : "Watch a protocol to begin"}</h2>
      <p>
        {hasProtocols
          ? "Use Next upgrade to replay history one version at a time. Label each alert and watch the next verdict change."
          : "Pick Cetus CLMM from v9 to replay its real upgrade history, including the May 2025 hotfix."}
      </p>
    </div>
  );
}

function DepthGauge({ withMem, without }: { withMem: RiskLevel; without: RiskLevel | null }) {
  const pos = (r: RiskLevel) => `${LEVELS.indexOf(r) * 25 + 12.5}%`;
  const delta = without ? LEVELS.indexOf(withMem) - LEVELS.indexOf(without) : 0;
  return (
    <div className="gauge" role="img" aria-label={`Risk ${withMem}${without ? `, ${without} without memory` : ""}`}>
      <div className="gauge-track">
        {LEVELS.map((l) => (
          <div key={l} className={`zone zone-${l}${l === withMem ? " here" : ""}`}>
            <span className="zone-name">{ZONE[l]}</span>
            <span className="zone-risk">{l}</span>
          </div>
        ))}
        {without && without !== withMem && (
          <div
            className={`gauge-arrow ${delta < 0 ? "down" : "up"}`}
            style={{ left: delta < 0 ? pos(withMem) : pos(without), width: `${Math.abs(delta) * 25}%` }}
          />
        )}
        {without && <div className="marker hollow" style={{ left: pos(without) }} title={`Without memory: ${without}`} />}
        <div className="marker filled" style={{ left: pos(withMem) }} title={`With memory: ${withMem}`} />
      </div>
      <div className="gauge-legend">
        <span>
          <i className="key filled" /> With memory: <strong>{withMem}</strong>
        </span>
        {without ? (
          <span>
            <i className="key hollow" /> Without memory: <strong>{without}</strong>
            {delta !== 0 && (
              <em className={delta < 0 ? "down" : "up"}>
                Memory {delta < 0 ? "lowered" : "raised"} the risk {Math.abs(delta)} level{Math.abs(delta) > 1 ? "s" : ""}
              </em>
            )}
            {delta === 0 && <em>Memory did not change the level</em>}
          </span>
        ) : (
          <span className="muted">Compare without memory to see what memory changed.</span>
        )}
      </div>
    </div>
  );
}

/**
 * Upgrade history as an echo-sounder recording (see src/lib/echogram/render.ts). The look comes
 * from the config saved in the echogram lab (/lab/echogram), so saving a keeper there ships it here.
 */
function Soundings({ protocol, alerts, current, onSelect }: { protocol: WatchRow; alerts: Alert[]; current: Alert | null; onSelect: (id: string) => void }) {
  const latest = protocol.latest ?? protocol.cursor;
  const byVersion = useMemo(
    () => new Map(alerts.filter((a) => a.slug === protocol.slug && a.type === "upgrade").map((a) => [a.version, a])),
    [alerts, protocol.slug],
  );
  const versions = Array.from({ length: Math.max(0, latest - protocol.startVersion) + 1 }, (_, i) => protocol.startVersion + i);
  const points: SoundingPoint[] = versions.map((v) => {
    const a = byVersion.get(v);
    if (!a) return { version: v, withMem: null, without: null, base: v === protocol.startVersion };
    return {
      version: v,
      withMem: a.verdict.risk,
      without: a.compare?.risk ?? a.baseline.risk,
      score: a.verdict.score,
      scoreWithout: a.compare?.score ?? a.baseline.score,
      label: a.triage?.label ?? null,
      moved: a.verdict.memoryInfluence.filter((i) => i.effect !== "context").length,
      current: current?.id === a.id,
    };
  });
  const key = JSON.stringify(points);
  // ~ the center column width at 1440px, so labels render at their real size
  const { svg, layout } = useMemo(() => renderEchogram(echogramConfig as EchogramConfig, points, 680), [key]);
  const analyzed = points.filter((p) => p.withMem);
  const moved = analyzed.filter((p) => p.without !== p.withMem).length;
  return (
    <div className="panel soundings">
      <div className="panel-head">
        <h2>{protocol.name} upgrade history</h2>
        <span className="muted">
          {analyzed.length === 0 ? `${versions.length - 1} upgrades to replay` : `memory changed ${moved} of ${analyzed.length} verdict${analyzed.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="echogram">
        <div dangerouslySetInnerHTML={{ __html: svg }} />
        {versions.map((v, i) => {
          const a = byVersion.get(v);
          if (!a) return null;
          return (
            <button
              key={v}
              className={`echogram-hit${current?.id === a.id ? " current" : ""}`}
              style={{ left: `${((layout.left + i * layout.segW) / layout.width) * 100}%`, width: `${(layout.segW / layout.width) * 100}%` }}
              onClick={() => onSelect(a.id)}
              aria-label={`v${v}: ${a.verdict.risk} with memory, ${a.compare?.risk ?? a.baseline.risk} without`}
            />
          );
        })}
      </div>
      <p className="wells-key muted">
        <i className="key-fill" /> verdict with memory <i className="key-ghost" /> without memory <span className="key-arch">⌒</span> memory that moved it
      </p>
    </div>
  );
}

function AlertDetail({ alert: a, busy, act, memoryLog, backend }: { alert: Alert; busy: string | null; act: Act; memoryLog: MemoryLogEntry[]; backend: "walrus" | "mock" }) {
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"signals" | "diff" | "tx">("signals");
  const v = a.verdict;
  const triaged = a.triage;
  const newSigner = a.signals.some((s) => s.kind === "signer-unknown");
  return (
    <div className="panel detail">
      <div className="detail-head">
        <div>
          <p className="muted">
            {a.protocolName}, {a.type === "cap" ? "UpgradeCap change" : `v${a.fromVersion} to v${a.version}`}, published {fmtDate(a.tx?.timestampMs ?? Date.parse(a.createdAt))}
          </p>
          <h2 className="verdict-title">{v.title}</h2>
        </div>
        <div className="engine">
          {v.engine === "claude" ? `Claude (${v.model})` : "Fallback engine"}
          {v.note && <span className="muted engine-note">{v.note}</span>}
        </div>
      </div>

      <DepthGauge withMem={v.risk} without={a.compare?.risk ?? null} />

      <p className="summary">{shortAddrs(v.summary)}</p>

      <div className="triage">
        <div className="triage-buttons" role="group" aria-label="Label this alert">
          {(["expected", "suspicious", "false-positive"] as TriageLabel[]).map((l) => (
            <button
              key={l}
              className={`btn label-btn label-${l}${triaged?.label === l ? " chosen" : ""}`}
              title={`Shortcut: ${l === "expected" ? "E" : l === "suspicious" ? "S" : "F"}`}
              disabled={!!busy}
              onClick={() => act(`triage:${l}`, { op: "triage", alertId: a.id, label: l, note: note || undefined })}
            >
              {busy === `triage:${l}` ? "Writing to Walrus…" : l === "false-positive" ? "False positive" : l === "expected" ? (newSigner ? "Expected, trust signer" : "Expected") : "Suspicious"}
            </button>
          ))}
          <button className="btn ghost" disabled={!!busy} onClick={() => act("compare", { op: "compare", alertId: a.id })} title="Shortcut: C">
            {busy === "compare" ? "Re-running with zero memories…" : a.compare ? "Re-run without memory" : "Compare without memory"}
          </button>
        </div>
        <input className="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note saved with the label" />
        {triaged && (
          <p className="muted">
            Labeled {triaged.label} {ago(triaged.at)}. Saved as {triaged.memoryLogIds.length} memor{triaged.memoryLogIds.length === 1 ? "y" : "ies"}:{" "}
            {triaged.memoryLogIds.map((id) => {
              const e = memoryLog.find((m) => m.id === id);
              return (
                <span key={id} className={`inline-status s-${e?.status ?? "pending"}`}>
                  {e?.status === "stored" ? short(e.blobId, 5) : (e?.status ?? "pending")}{" "}
                </span>
              );
            })}
          </p>
        )}
      </div>

      <Influence verdict={v} recalled={a.recalled} sync={a.memorySync} backend={backend} />

      {a.compare && <CompareNote compare={a.compare} />}

      <div className="verdict-body">
        <ul className="reasons">
          {v.reasons.map((r, i) => (
            <li key={i}>{shortAddrs(r)}</li>
          ))}
        </ul>
        <p className="action">
          <strong>Suggested action.</strong> {v.suggestedAction}
        </p>
      </div>

      <div className="tabs" role="tablist">
        {(["signals", "diff", "tx"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "signals" ? `Signals (${a.signals.length})` : t === "diff" ? "ABI diff" : "Transaction"}
          </button>
        ))}
      </div>
      {tab === "signals" && <Signals signals={a.signals} verdict={v} />}
      {tab === "diff" && <Diff alert={a} />}
      {tab === "tx" && <Tx alert={a} />}
    </div>
  );
}

function CompareNote({ compare }: { compare: Verdict & { at: string } }) {
  return (
    <details className="compare">
      <summary>
        Verdict without memory: <RiskPill risk={compare.risk} faint /> {compare.title}
      </summary>
      <p>{compare.summary}</p>
      <ul className="reasons">
        {compare.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </details>
  );
}

const EFFECT_TEXT = { downgraded: "Lowered risk", escalated: "Raised risk", context: "Context" } as const;

function memoryLabel(m: Memory) {
  const { tags } = splitMemory(m.text);
  const kind = tagValue(tags, "kind") ?? "memory";
  const version = tags.find((t) => /^v\d+$/.test(t));
  return `${kind[0].toUpperCase()}${kind.slice(1)}${version ? ` ${version}` : ""}`;
}

function BlobLink({ id, pending, backend }: { id: string; pending: boolean; backend: "walrus" | "mock" }) {
  if (pending) return <span className="s-pending">writing to Walrus</span>;
  if (backend === "mock") return <span>mock {short(id, 6)}</span>;
  return (
    <a href={`https://walruscan.com/mainnet/blob/${id}`} target="_blank" rel="noreferrer" title={id}>
      blob {short(id, 6)}
    </a>
  );
}

function Influence({ verdict, recalled, sync, backend }: { verdict: Verdict; recalled: Memory[]; sync: Alert["memorySync"]; backend: "walrus" | "mock" }) {
  const byId = new Map(recalled.map((m) => [m.id, m]));
  const movers = verdict.memoryInfluence.filter((i) => i.effect !== "context" && byId.has(i.memoryId));
  const cited = new Set(movers.map((i) => i.memoryId));
  const context = recalled.filter((m) => !cited.has(m.id));
  return (
    <div className="influence">
      <div className="panel-head">
        <h3>Memory influence</h3>
        <span className="muted">
          {recalled.length} recalled{sync.pendingIncluded ? `, ${sync.pendingIncluded} still writing` : ""}
        </span>
      </div>
      {recalled.length === 0 && <p className="empty">No memories were used. This is what WatchSeal knows from the chain alone.</p>}
      {recalled.length > 0 && movers.length === 0 && <p className="empty">Memories were read, but none changed this verdict.</p>}
      <ul>
        {movers.map((i) => {
          const m = byId.get(i.memoryId)!;
          const { tags, body } = splitMemory(m.text);
          const label = tagValue(tags, "label");
          return (
            <li key={i.memoryId} className={`mem mem-${i.effect}`}>
              <span className={`effect effect-${i.effect}`}>{EFFECT_TEXT[i.effect]}</span>
              <div className="mem-main">
                <p className="mem-why">{shortAddrs(i.reason)}</p>
                <div className="mem-meta">
                  <span className="kind">{memoryLabel(m)}</span>
                  {label && <span className={`label-badge label-${label}`}>{label}</span>}
                  <span className="blob mono">
                    <BlobLink id={m.id} pending={m.status === "pending"} backend={backend} />
                  </span>
                </div>
                <p className="mem-body" title={m.text}>
                  {shortAddrs(body)}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {context.length > 0 && (
        <p className="context-line">
          Also read:{" "}
          {context.map((m, idx) => (
            <span key={m.id} title={m.text}>
              {memoryLabel(m)}
              {idx < context.length - 1 ? ", " : ""}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

const KIND_TEXT: Record<string, string> = {
  "module-added": "New module",
  "module-removed": "Module removed",
  "fn-removed": "Function removed",
  "new-public-fn": "New public fn",
  "new-entry-fn": "New entry fn",
  "sensitive-fn": "Sensitive fn",
  "visibility-widened": "Visibility widened",
  "new-cap-type": "New capability type",
  "struct-changed": "Struct changed",
  "bytecode-only": "Bytecode only",
  "signer-unknown": "Unknown signer",
  "single-key-signer": "Single-key signer",
  "cap-owner-changed": "UpgradeCap moved",
  "cap-policy-changed": "Cap policy changed",
  "cap-destroyed": "Cap destroyed",
};

function Signals({ signals, verdict }: { signals: Signal[]; verdict: Verdict }) {
  if (!signals.length) return <p className="empty">No signals: the package changed nothing an analyst would act on.</p>;
  const breakdown = new Map(verdict.breakdown.map((b) => [b.kind, b]));
  const kinds = [...new Set(signals.map((s) => s.kind))];
  return (
    <div className="signals">
      {kinds.map((k) => {
        const b = breakdown.get(k);
        const list = signals.filter((s) => s.kind === k);
        return (
          <div key={k} className="sig-group">
            <div className="sig-head">
              <strong>{KIND_TEXT[k] ?? k}</strong>
              <span className="muted">x{list.length}</span>
              {b && b.multiplier < 0.99 && <span className="effect effect-downgraded">x{b.multiplier.toFixed(2)} by memory</span>}
              {b && b.multiplier > 1.01 && <span className="effect effect-escalated">x{b.multiplier.toFixed(2)} by memory</span>}
              {b && <span className="contrib">+{b.contribution.toFixed(2)}</span>}
            </div>
            <ul>
              {list.slice(0, 12).map((s) => (
                <li key={s.id}>
                  <code>{s.subject.length > 50 ? short(s.subject, 10) : s.subject}</code> <span className="muted">{s.detail}</span>
                </li>
              ))}
              {list.length > 12 && <li className="muted">and {list.length - 12} more</li>}
            </ul>
          </div>
        );
      })}
      <p className="muted score">
        Score {verdict.score}. Code-surface signals cap at high; critical needs an authority anomaly or an analyst rule.
      </p>
    </div>
  );
}

function Diff({ alert: a }: { alert: Alert }) {
  const d = a.diff;
  if (!d) return <p className="empty">{a.diffSummary}</p>;
  return (
    <div className="diff">
      {d.addedModules.length > 0 && (
        <p>
          <strong>New modules:</strong> {d.addedModules.map((m) => <code key={m}>{m}</code>)}
        </p>
      )}
      {d.addedFunctions.length > 0 && (
        <div>
          <strong>{d.addedFunctions.length} new public or entry functions</strong>
          <ul className="fn-list">
            {d.addedFunctions.map((f) => (
              <li key={`${f.module}::${f.fn.name}`}>
                <code>
                  <span className="vis">{f.fn.visibility}{f.fn.isEntry ? " entry" : ""}</span> {f.module}::<b>{f.fn.name}</b>({f.fn.params.join(", ")})
                </code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.changedFunctions.length > 0 && (
        <p>
          <strong>Changed:</strong> {d.changedFunctions.map((c) => <code key={c.name}>{c.module}::{c.name}</code>)}
        </p>
      )}
      {d.addedStructs.length > 0 && (
        <p>
          <strong>New types:</strong>{" "}
          {d.addedStructs.map((s) => (
            <code key={s.s.name}>
              {s.module}::{s.s.name} {"{"}
              {s.s.abilities.join(", ")}
              {"}"}
            </code>
          ))}
        </p>
      )}
      <p>
        <strong>Bytecode changed in {d.bytecodeChanged.length} modules</strong>
        {d.bytecodeOnly.length > 0 && <>, ABI identical in: {d.bytecodeOnly.map((m) => <code key={m}>{m}</code>)}</>}
      </p>
      {d.addedPrivateCount > 0 && <p className="muted">{d.addedPrivateCount} new private functions not shown.</p>}
    </div>
  );
}

function Tx({ alert: a }: { alert: Alert }) {
  const tx = a.tx;
  if (a.capChange) {
    const { before, after } = a.capChange;
    return (
      <dl className="tx">
        <dt>UpgradeCap</dt>
        <dd className="mono">{short(after.capId, 8)}</dd>
        <dt>Owner</dt>
        <dd className="mono">
          {before?.ownerKind} {short(before?.owner)} to {after.ownerKind} {short(after.owner)}
        </dd>
        <dt>Policy</dt>
        <dd>
          {before?.policy} to {after.policy}
        </dd>
      </dl>
    );
  }
  if (!tx) return <p className="empty">Upgrade transaction not found.</p>;
  const src = tx.source === "tatum" ? "via Tatum gRPC" : tx.source === "archival" ? "archival GraphQL (pruned from full nodes)" : "recorded fixture";
  return (
    <dl className="tx">
      <dt>Signer</dt>
      <dd className="mono">{tx.sender}</dd>
      <dt>Scheme</dt>
      <dd>{tx.schemes.join(" + ") || "unknown"}</dd>
      <dt>Date</dt>
      <dd>{tx.timestampMs ? new Date(tx.timestampMs).toUTCString() : "unknown"}</dd>
      <dt>UpgradeCap owner</dt>
      <dd className="mono">
        {tx.capOwner ?? "?"}
        {a.prevTx?.capOwner && a.prevTx.capOwner !== tx.capOwner && <span className="effect effect-escalated">moved from {short(a.prevTx.capOwner)}</span>}
      </dd>
      <dt>Digest</dt>
      <dd className="mono">
        <a href={`https://suiscan.xyz/mainnet/tx/${tx.digest}`} target="_blank" rel="noreferrer">
          {tx.digest}
        </a>
      </dd>
      <dt>Package</dt>
      <dd className="mono">
        <a href={`https://suiscan.xyz/mainnet/object/${a.packageId}`} target="_blank" rel="noreferrer">
          {short(a.packageId, 8)}
        </a>
      </dd>
      <dt>Data source</dt>
      <dd>
        <span className={`source source-${tx.source}`}>{src}</span>
      </dd>
    </dl>
  );
}

function Rules({ view, busy, act }: { view: View | null; busy: string | null; act: Act }) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState("");
  const rules = (view?.memoryLog ?? []).filter((m) => m.kind === "rule");
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Standing rules</h2>
        <span className="muted">{rules.length}</span>
      </div>
      <form
        className="rule-form"
        onSubmit={(e) => {
          e.preventDefault();
          act("rule", { op: "rule", text, slug: scope || null }, () => setText(""));
        }}
      >
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Always escalate new withdraw functions" required />
        <div className="form-row">
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Rule scope">
            <option value="">All protocols</option>
            {view?.watchlist.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!!busy || !text.trim()}>
            {busy === "rule" ? "Saving…" : "Save rule"}
          </button>
        </div>
      </form>
      <ul className="rule-list">
        {rules.map((r) => {
          const { tags, body } = splitMemory(r.text);
          return (
            <li key={r.id}>
              <span className={`status-dot s-${r.status}`} title={r.status} />
              <span>{body.replace(/^Standing rule( for [^:]+)?: /, "")}</span>
              <span className="muted"> {tagValue(tags, "protocol") === "*" ? "all" : tagValue(tags, "protocol")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MemoryLog({ log, status, slug }: { log: MemoryLogEntry[]; status: Status | null; slug: string | null }) {
  const [tab, setTab] = useState<"written" | "ask">("written");
  const stored = log.filter((e) => e.status === "stored").length;
  return (
    <div className="panel memlog">
      <div className="panel-head">
        <h2>Memory on Walrus</h2>
        <span className="muted">
          {stored} stored{log.length > stored ? `, ${log.length - stored} pending` : ""}
        </span>
      </div>
      {status?.memory.delegatePublicKey && (
        <p className="muted agent-id">
          Agent key <span className="mono">{short(status.memory.delegatePublicKey, 8)}</span> in namespace {status.memory.namespace}
        </p>
      )}
      <div className="tabs mem-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "written"} className={tab === "written" ? "on" : ""} onClick={() => setTab("written")}>
          Written
        </button>
        <button role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "on" : ""} onClick={() => setTab("ask")}>
          Ask the memory
        </button>
      </div>
      {tab === "ask" ? (
        <MemoryExplorer slug={slug} backend={status?.memory.backend ?? "mock"} />
      ) : log.length === 0 ? (
        <p className="empty">Labels, rules and trusted signers are written here as memories.</p>
      ) : (
        <ul>
          {log.map((e) => {
            const { tags, body } = splitMemory(e.text);
            const label = tagValue(tags, "label");
            const version = tags.find((t) => /^v\d+$/.test(t));
            return (
              <li key={e.id} className={`log-item s-${e.status}`}>
                <div className="mem-meta">
                  <span className={`status-dot s-${e.status}`} />
                  <span className="kind">{e.kind[0].toUpperCase() + e.kind.slice(1)}</span>
                  {label && <span className={`label-badge label-${label}`}>{label}</span>}
                  <span className="muted">
                    {tagValue(tags, "protocol") === "*" ? "all protocols" : tagValue(tags, "protocol")} {version}
                  </span>
                  <span className="muted when">{ago(e.createdAt)}</span>
                </div>
                <p className="mem-body">{shortAddrs(body)}</p>
                <p className="blob mono">
                  {e.status === "failed" ? (
                    <span className="s-failed">failed: {e.error}</span>
                  ) : e.status === "stored" && e.blobId ? (
                    <BlobLink id={e.blobId} pending={false} backend={e.backend} />
                  ) : (
                    <span className="s-pending">embedding, encrypting, uploading to Walrus</span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const ASK_EXAMPLES = ["Who is allowed to upgrade Cetus?", "What did I call noise?", "Rules about withdrawals", "Suspicious config changes"];

/** Live semantic recall against Walrus Memory: what does WatchSeal remember about X? */
function MemoryExplorer({ slug, backend }: { slug: string | null; backend: "walrus" | "mock" }) {
  const [q, setQ] = useState("");
  const [scoped, setScoped] = useState(true);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ query: string; results: Memory[]; ms: number; namespace: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function ask(query: string) {
    if (!query.trim()) return;
    setQ(query);
    setBusy(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ q: query });
      if (scoped && slug) params.set("slug", slug);
      const r = await fetch(`/api/recall?${params}`, { cache: "no-store" });
      const body = await r.json();
      if (!body.ok) throw new Error(body.error);
      setRes(body);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="explorer">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask what WatchSeal remembers" aria-label="Ask the memory" />
        <button className="btn primary" disabled={busy || !q.trim()}>
          {busy ? "Recalling…" : "Recall"}
        </button>
      </form>
      <div className="ask-examples">
        {ASK_EXAMPLES.map((x) => (
          <button key={x} type="button" className="chip-btn" onClick={() => ask(x)} disabled={busy}>
            {x}
          </button>
        ))}
      </div>
      {slug && (
        <label className="scope">
          <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} /> Only this protocol and global rules
        </label>
      )}
      {err && <p className="s-failed">{err}</p>}
      {res && (
        <>
          <p className="muted recall-meta">
            {res.results.length} memor{res.results.length === 1 ? "y" : "ies"} from {backend === "walrus" ? "Walrus Mainnet" : "the offline mock"} in{" "}
            {res.ms} ms, nearest first. Recall is semantic: it matches meaning, not keywords.
          </p>
          <ul className="recall-list">
            {res.results.map((m) => {
              const { tags, body } = splitMemory(m.text);
              const label = tagValue(tags, "label");
              const similarity = Math.max(0, Math.min(1, 1 - (m.distance ?? 1)));
              return (
                <li key={m.id}>
                  <div className="mem-meta">
                    <span className="kind">{memoryLabel(m)}</span>
                    {label && <span className={`label-badge label-${label}`}>{label}</span>}
                    <span className="muted">{m.tags.protocol === "*" ? "all protocols" : m.tags.protocol}</span>
                    <span className="sim" title={`distance ${m.distance?.toFixed(3)}`}>
                      <span className="sim-track">
                        <i style={{ width: `${Math.round(similarity * 100)}%` }} />
                      </span>
                      <span>{Math.round(similarity * 100)}%</span>
                    </span>
                  </div>
                  <p className="mem-body">{shortAddrs(body)}</p>
                  <p className="blob mono">
                    <BlobLink id={m.id} pending={m.status === "pending"} backend={backend} />
                    {m.createdAt && <span className="muted"> written {ago(m.createdAt)}</span>}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
