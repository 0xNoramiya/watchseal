import type { Assessment, Influence, KindBreakdown, RiskLevel } from "../analysis/risk";
import { KIND_LABEL, type Signal } from "../analysis/signals";

export interface Verdict {
  risk: RiskLevel;
  title: string;
  summary: string;
  reasons: string[];
  memoryInfluence: Influence[];
  suggestedAction: string;
  engine: "claude" | "fallback";
  model?: string;
  score: number;
  breakdown: KindBreakdown[];
  memoriesUsed: number;
  note?: string;
}

const ACTION: Record<RiskLevel, string> = {
  low: "No action needed. Spot-check the diff when convenient.",
  medium: "Review the new functions and confirm they match the protocol's announced release.",
  high: "Review before interacting with this package: read the new public surface and confirm the release with the team.",
  critical: "Treat as an incident until verified: confirm the signer and UpgradeCap holder out of band and pause integrations.",
};

/** Deterministic verdict built from the memory-aware assessment. Same inputs as the Claude agent sees. */
export function fallbackVerdict(p: {
  protocolName: string;
  version: number;
  signals: Signal[];
  assessment: Assessment;
  memoriesUsed: number;
  note?: string;
}): Verdict {
  const { assessment: a, signals } = p;
  const top = a.breakdown.filter((b) => b.contribution > 0).slice(0, 3);
  const headline = top.length ? top.map((b) => `${b.count} ${KIND_LABEL[b.kind]}${b.count > 1 ? "s" : ""}`).join(", ") : "no notable change";
  const reasons: string[] = [];
  for (const b of a.breakdown) {
    if (b.contribution <= 0) continue;
    const examples = signals
      .filter((s) => s.kind === b.kind)
      .slice(0, 3)
      .map((s) => s.subject)
      .join(", ");
    const mem = b.multiplier < 0.99 ? " (discounted by memory)" : b.multiplier > 1.01 ? " (escalated by memory)" : "";
    reasons.push(`${KIND_LABEL[b.kind]} x${b.count}: ${examples}${mem}`);
  }
  if (a.ruleBoost > 0) reasons.push(`standing rule matched (+${a.ruleBoost})`);
  const down = a.influences.filter((i) => i.effect === "downgraded").length;
  const up = a.influences.filter((i) => i.effect === "escalated").length;
  const memLine =
    p.memoriesUsed === 0
      ? "No memories were used."
      : `${p.memoriesUsed} memories recalled: ${down} downgraded, ${up} escalated.`;
  return {
    risk: a.risk,
    title: `${p.protocolName} v${p.version}: ${headline}`,
    summary: `Deterministic engine scored ${a.score} (${a.risk}). ${memLine}`,
    reasons: reasons.slice(0, 8),
    memoryInfluence: a.influences.filter((i) => i.effect !== "context" || p.memoriesUsed < 6),
    suggestedAction: ACTION[a.risk],
    engine: "fallback",
    score: a.score,
    breakdown: a.breakdown,
    memoriesUsed: p.memoriesUsed,
    note: p.note,
  };
}
