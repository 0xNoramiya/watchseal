import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Verdict } from "./agent/verdict";
import type { AbiDiff } from "./analysis/diff";
import type { RiskLevel } from "./analysis/risk";
import type { Signal } from "./analysis/signals";
import type { CapState, PackageVersion, UpgradeTx } from "./chain/types";
import type { Memory, TriageLabel } from "./memory/format";
import type { MemoryLogEntry } from "./memory/store";
import { counters, loadCounters, type Counters } from "./metrics";

export interface WatchedProtocol {
  slug: string;
  name: string;
  originalId: string;
  capId: string | null;
  mode: "replay" | "live";
  versions: PackageVersion[];
  startVersion: number;
  /** Last version analyzed (or the baseline). */
  cursor: number;
  lastCap: CapState | null;
  addedAt: string;
  lastScanAt?: string;
}

export interface Alert {
  id: string;
  slug: string;
  protocolName: string;
  type: "upgrade" | "cap";
  version: number;
  fromVersion: number;
  packageId: string;
  createdAt: string;
  tx: UpgradeTx | null;
  prevTx: UpgradeTx | null;
  diff: AbiDiff | null;
  diffSummary: string;
  signals: Signal[];
  /** Signals as they look with zero memory (no known authorities). */
  baseSignals: Signal[];
  recalled: Memory[];
  verdict: Verdict;
  baseline: { risk: RiskLevel; score: number };
  compare?: Verdict & { at: string };
  triage?: { label: TriageLabel; note?: string; at: string; memoryLogIds: string[] };
  memorySync: { settled: boolean; pendingIncluded: number };
  capChange?: { before: CapState | null; after: CapState };
}

export interface AppState {
  version: 1;
  watchlist: WatchedProtocol[];
  alerts: Alert[];
  memoryLog: MemoryLogEntry[];
  counters: Counters;
}

function empty(): AppState {
  return { version: 1, watchlist: [], alerts: [], memoryLog: [], counters };
}

export class StateStore {
  state: AppState;
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.file = path.resolve(file);
    this.state = empty();
    if (existsSync(this.file)) {
      let loaded: AppState;
      try {
        loaded = JSON.parse(readFileSync(this.file, "utf8")) as AppState;
      } catch (err) {
        throw new Error(`${this.file} is not valid JSON (${(err as Error).message}). Fix it, or delete it to start fresh.`);
      }
      loadCounters(loaded.counters);
      this.state = { ...empty(), ...loaded, counters };
    }
  }

  /** Debounced atomic write. */
  save(immediate = false) {
    if (this.timer) clearTimeout(this.timer);
    const write = () => {
      this.timer = null;
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...this.state, counters }, null, 1));
      renameSync(tmp, this.file);
    };
    if (immediate) write();
    else this.timer = setTimeout(write, 150);
  }

  protocol(slug: string): WatchedProtocol {
    const p = this.state.watchlist.find((w) => w.slug === slug);
    if (!p) throw new Error(`not watching ${slug}`);
    return p;
  }

  alert(id: string): Alert {
    const a = this.state.alerts.find((x) => x.id === id);
    if (!a) throw new Error(`no alert ${id}`);
    return a;
  }
}
