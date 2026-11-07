import type { Memory } from "../memory/format";
import { IDENTITY_KINDS, KIND_LABEL, type Signal, type SignalKind } from "./signals";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export const LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];

/**
 * Calibration. Naive weighted sums saturate on big releases, which leaves memory no
 * room to move the verdict. So:
 *  - each signal kind's contribution is capped,
 *  - the code-surface total is capped just below "critical" (surface changes alone top out at "high"),
 *  - "critical" needs an authority anomaly (signer, scheme, UpgradeCap) or an analyst rule.
 */
export const KIND_CAP: Record<SignalKind, number> = {
  "module-removed": 4,
  "fn-removed": 3,
  "module-added": 2,
  "new-public-fn": 2,
  "new-entry-fn": 2,
  "sensitive-fn": 4,
  "visibility-widened": 4,
  "new-cap-type": 3,
  "struct-changed": 3,
  "bytecode-only": 2,
  "signer-unknown": 4,
  "single-key-signer": 3,
  "cap-owner-changed": 3,
  "cap-policy-changed": 2,
  "cap-destroyed": 0,
};
const SURFACE_CAP = 9.5;
const RULE_BOOST = 3;
const RULE_BOOST_CAP = 6;
const THRESHOLDS: [RiskLevel, number][] = [
  ["critical", 10],
  ["high", 5.5],
  ["medium", 2.5],
  ["low", -Infinity],
];

const MULT = { "false-positive": 0.25, expected: 0.4, suspicious: 1.6, ruleDowngrade: 0.25 } as const;

export function levelFor(score: number): RiskLevel {
  return THRESHOLDS.find(([, t]) => score >= t)![0];
}

export interface Influence {
  memoryId: string;
  effect: "downgraded" | "escalated" | "context";
  reason: string;
  signalIds?: string[];
}

export interface KindBreakdown {
  kind: SignalKind;
  count: number;
  raw: number;
  multiplier: number;
  contribution: number;
}

export interface Assessment {
  risk: RiskLevel;
  score: number;
  breakdown: KindBreakdown[];
  ruleBoost: number;
  influences: Influence[];
  /** Signals touched by memory, with the multiplier applied. */
  adjusted: Record<string, number>;
}

function protocolMatch(m: Memory, slug: string) {
  return m.tags.protocol === "*" || m.tags.protocol === slug;
}

function overlap(a: string[] = [], b: string[] = []) {
  return a.some((x) => b.includes(x));
}

/** Does a triage memory speak about this signal? Kind must match, plus module/word specificity where it matters. */
function triageMatches(m: Memory, s: Signal): boolean {
  if (!m.tags.sigs.includes(s.kind)) return false;
  if (s.kind === "bytecode-only") return !!s.module && m.tags.mods.includes(s.module);
  if ((s.kind === "sensitive-fn" || s.kind === "visibility-widened") && s.words?.length) return overlap(s.words, m.tags.words);
  return true;
}

function ruleMatches(m: Memory, s: Signal): boolean {
  if (m.tags.mods.length && (!s.module || !m.tags.mods.includes(s.module))) return false;
  if (m.tags.sigs.includes(s.kind)) return true;
  const subject = s.subject.toLowerCase();
  const tokens = subject.split(/::|_/);
  return m.tags.kw.some((k) =>
    k.includes("_") ? subject.includes(k) : tokens.some((t) => t.startsWith(k)) || (s.words ?? []).includes(k),
  );
}

export function learnedBefore(m: Memory, version: number): boolean {
  return m.tags.version === undefined || m.tags.version < version;
}

function recency(m: Memory): number {
  return (m.tags.version ?? 0) * 1e13 + (m.createdAt ? Date.parse(m.createdAt) || 0 : 0);
}

export interface AssessInput {
  slug: string;
  version: number;
  sender: string | null;
  signals: Signal[];
  memories: Memory[];
}

export function assess({ slug, version, sender, signals, memories }: AssessInput): Assessment {
  const mult: Record<string, number> = {};
  const influences = new Map<string, Influence>();
  const touch = (m: Memory, effect: Influence["effect"], reason: string, signalId?: string) => {
    const cur = influences.get(m.id);
    if (cur) {
      if (signalId && !cur.signalIds?.includes(signalId)) cur.signalIds = [...(cur.signalIds ?? []), signalId];
      return;
    }
    influences.set(m.id, { memoryId: m.id, effect, reason, signalIds: signalId ? [signalId] : [] });
  };

  // Only what was learned before this version counts: a label on this very version (or a later one,
  // when replaying history) must not feed back into the verdict.
  const relevant = memories.filter((m) => protocolMatch(m, slug) && learnedBefore(m, version));
  const triage = relevant.filter((m) => m.tags.kind === "triage" && m.tags.label);
  const rules = relevant.filter((m) => m.tags.kind === "rule");
  const authorities = relevant.filter((m) => m.tags.kind === "authority");

  // 1. Triage labels: newest matching label wins per signal. Identity signals are never relabeled.
  for (const s of signals) {
    if (IDENTITY_KINDS.includes(s.kind)) continue;
    const match = triage.filter((m) => triageMatches(m, s)).sort((a, b) => recency(b) - recency(a))[0];
    if (!match) continue;
    const label = match.tags.label!;
    mult[s.id] = MULT[label];
    touch(
      match,
      label === "suspicious" ? "escalated" : "downgraded",
      `v${match.tags.version ?? "?"} was labeled ${label}; it covered ${KIND_LABEL[s.kind]}${s.module ? ` in ${s.module}` : ""}`,
      s.id,
    );
  }

  // 2. Standing rules.
  let ruleBoost = 0;
  let ruleFloor = false;
  for (const r of rules) {
    const hits = signals.filter((s) => ruleMatches(r, s));
    if (!hits.length) continue;
    if (r.tags.act === "downgrade") {
      for (const s of hits) if (!IDENTITY_KINDS.includes(s.kind)) mult[s.id] = Math.min(mult[s.id] ?? 1, MULT.ruleDowngrade);
      touch(r, "downgraded", `rule matched ${hits.map((h) => h.subject).slice(0, 3).join(", ")}`);
    } else {
      ruleBoost = Math.min(RULE_BOOST_CAP, ruleBoost + RULE_BOOST);
      ruleFloor = true;
      touch(r, "escalated", `rule matched ${hits.map((h) => h.subject).slice(0, 3).join(", ")}`);
    }
    for (const h of hits) influences.get(r.id)!.signalIds!.push(h.id);
  }

  // 3. Authorities: they decide whether "signer-unknown" exists at all (computed upstream).
  const unknown = signals.find((s) => s.kind === "signer-unknown");
  for (const a of authorities) {
    if (unknown) touch(a, "escalated", `signer ${unknown.subject.slice(0, 10)}… is not this known authority`, unknown.id);
    else if (sender && a.tags.signer === sender.toLowerCase()) touch(a, "context", "signer is a known upgrade authority");
  }
  for (const b of relevant.filter((m) => m.tags.kind === "baseline")) touch(b, "context", "protocol baseline");

  // Score.
  const byKind = new Map<SignalKind, Signal[]>();
  for (const s of signals) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  const breakdown: KindBreakdown[] = [];
  let surface = 0;
  let identity = 0;
  for (const [kind, list] of byKind) {
    const raw = list.reduce((n, s) => n + s.weight, 0);
    const eff = list.reduce((n, s) => n + s.weight * (mult[s.id] ?? 1), 0);
    const multiplier = raw ? eff / raw : 1;
    const contribution = Math.min(KIND_CAP[kind], raw) * multiplier;
    breakdown.push({ kind, count: list.length, raw, multiplier, contribution });
    if (IDENTITY_KINDS.includes(kind)) identity += contribution;
    else surface += contribution;
  }
  const score = Math.min(SURFACE_CAP, surface) + identity + ruleBoost;
  let risk = levelFor(score);
  if (ruleFloor && LEVELS.indexOf(risk) < LEVELS.indexOf("high")) risk = "high";
  breakdown.sort((a, b) => b.contribution - a.contribution);
  return { risk, score: Math.round(score * 100) / 100, breakdown, ruleBoost, influences: [...influences.values()], adjusted: mult };
}

/**
 * Makes sure a net memory effect is visible as a level change relative to the memory-free verdict.
 */
export function enforceMemoryEffect(withMem: RiskLevel, withoutMem: RiskLevel, influences: Influence[]): RiskLevel {
  const down = influences.filter((i) => i.effect === "downgraded").length;
  const up = influences.filter((i) => i.effect === "escalated").length;
  const i0 = LEVELS.indexOf(withoutMem);
  const i1 = LEVELS.indexOf(withMem);
  if (up > 0 && down === 0 && i1 <= i0 && i0 < 3) return LEVELS[i0 + 1];
  if (down > 0 && up === 0 && i1 >= i0 && i0 > 0) return LEVELS[i0 - 1];
  return withMem;
}
