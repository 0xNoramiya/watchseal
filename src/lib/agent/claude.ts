import Anthropic from "@anthropic-ai/sdk";
import type { AbiDiff } from "../analysis/diff";
import { LEVELS, type Assessment, type Influence, type RiskLevel } from "../analysis/risk";
import type { Signal } from "../analysis/signals";
import type { UpgradeTx } from "../chain/types";
import { env } from "../env";
import type { Memory } from "../memory/format";
import { bump } from "../metrics";
import { fallbackVerdict, type Verdict } from "./verdict";

const SYSTEM = `You are WatchSeal, a security analyst agent that triages Sui Move package upgrades.

For each upgrade you receive: the ABI diff between the previous and new package version, memory-free risk signals, the upgrade transaction (signer, signature scheme, UpgradeCap owner), and memories recalled from the analyst's Walrus Memory: past triage labels, standing rules, known upgrade authorities and baselines.

Rating rubric (low | medium | high | critical):
- low: no new externally callable surface, or only changes the analyst's memories mark as routine or noise.
- medium: new public functions without sensitive names, or bytecode-only changes. Bytecode-only changes across many modules at once are usually dependency relinks.
- high: new sensitive functions (withdraw, mint, flash, emergency, admin, capabilities), new modules, or the UpgradeCap moving between multisig addresses. Code-surface changes alone never exceed high.
- critical: only when at least one holds: (a) the signer is NOT among the known authorities recalled from memory, (b) the upgrade was signed by a single key rather than a multisig, (c) a standing rule from memory matches.
- Without memories there are no known authorities, so you cannot conclude that a signer is new or untrusted. An UpgradeCap moving to the multisig that then signs the upgrade is a normal key rotation pattern until memory says otherwise.
- The deterministic engine's assessment is given as a calibration anchor. Start from it; deviate only with a concrete reason you state.

How to use memory:
- The analyst's past labels are the strongest evidence you have about what is normal for this protocol. When a past label matches a current signal, follow it: "false-positive" or "expected" downgrades, "suspicious" escalates. When labels conflict, the newest version wins.
- A label never clears an identity signal (unknown signer, single-key signer, UpgradeCap move). Only an authority memory makes a signer known.
- A standing rule that matches always escalates (or downgrades, if the rule says so).
- If memories change your rating relative to the memory-free assessment, the risk you return must differ from the memory-free risk.
- In memoryInfluence, cite only memory ids from the provided list, each at most once. Use "context" for memories you read but that did not move the verdict.

Write for a busy on-call analyst: a short specific title (under 12 words), a 2 sentence summary, 3 to 5 reasons of one line each (under 20 words, naming functions or modules), and one suggested action in one sentence. No em dashes.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    risk: { type: "string", enum: LEVELS },
    title: { type: "string" },
    summary: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    memoryInfluence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          memoryId: { type: "string" },
          effect: { type: "string", enum: ["downgraded", "escalated", "context"] },
          reason: { type: "string" },
        },
        required: ["memoryId", "effect", "reason"],
      },
    },
    suggestedAction: { type: "string" },
  },
  required: ["risk", "title", "summary", "reasons", "memoryInfluence", "suggestedAction"],
} as const;

export interface AgentInput {
  protocolName: string;
  slug: string;
  version: number;
  fromVersion: number;
  diff: AbiDiff;
  signals: Signal[];
  tx: UpgradeTx | null;
  memories: Memory[];
  /** Deterministic assessment with memory. */
  assessment: Assessment;
  /** Deterministic assessment without memory, as an anchor. */
  baseline: Assessment;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!env.anthropicKey || env.offline) return null;
  client ??= new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2, timeout: 90_000 });
  return client;
}

export function claudeAvailable() {
  return !!env.anthropicKey && !env.offline;
}

function compactDiff(d: AbiDiff) {
  return {
    addedModules: d.addedModules,
    removedModules: d.removedModules,
    addedFunctions: d.addedFunctions.slice(0, 60).map((f) => ({
      fn: `${f.module}::${f.fn.name}`,
      visibility: f.fn.visibility,
      entry: f.fn.isEntry,
      params: f.fn.params,
    })),
    addedFunctionsTruncated: Math.max(0, d.addedFunctions.length - 60),
    changedFunctions: d.changedFunctions.map((c) => ({ fn: `${c.module}::${c.name}`, widened: c.visibilityWidened, entryAdded: c.entryAdded })),
    addedTypes: d.addedStructs.map((s) => `${s.module}::${s.s.name} {${s.s.abilities.join(",")}}`),
    bytecodeOnlyModules: d.bytecodeOnly,
  };
}

/** Extracts a JSON object from a text response (fallback if structured output is unavailable). */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function validate(raw: unknown, allowedIds: Set<string>): Omit<Verdict, "engine" | "score" | "breakdown" | "memoriesUsed"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!LEVELS.includes(r.risk as RiskLevel)) return null;
  const seen = new Set<string>();
  const influences: Influence[] = [];
  for (const i of Array.isArray(r.memoryInfluence) ? r.memoryInfluence : []) {
    const x = i as Record<string, unknown>;
    const id = String(x.memoryId ?? "");
    if (!allowedIds.has(id) || seen.has(id)) continue; // only memories we actually passed in
    if (x.effect !== "downgraded" && x.effect !== "escalated" && x.effect !== "context") continue;
    seen.add(id);
    influences.push({ memoryId: id, effect: x.effect, reason: String(x.reason ?? "").slice(0, 300) });
  }
  return {
    risk: r.risk as RiskLevel,
    title: String(r.title ?? "").slice(0, 160),
    summary: String(r.summary ?? "").slice(0, 800),
    reasons: (Array.isArray(r.reasons) ? r.reasons : []).map(String).slice(0, 8),
    memoryInfluence: influences,
    suggestedAction: String(r.suggestedAction ?? "").slice(0, 300),
  };
}

export async function rateWithClaude(input: AgentInput): Promise<Verdict> {
  const fallback = (note?: string) =>
    fallbackVerdict({
      protocolName: input.protocolName,
      version: input.version,
      signals: input.signals,
      assessment: input.assessment,
      memoriesUsed: input.memories.length,
      note,
    });
  const c = getClient();
  if (!c) {
    bump("fallbackVerdicts");
    return fallback("ANTHROPIC_API_KEY not set");
  }

  const payload = {
    protocol: { name: input.protocolName, slug: input.slug },
    upgrade: { from: `v${input.fromVersion}`, to: `v${input.version}` },
    transaction: input.tx && {
      digest: input.tx.digest,
      date: input.tx.timestampMs ? new Date(input.tx.timestampMs).toISOString() : null,
      sender: input.tx.sender,
      signatureSchemes: input.tx.schemes,
      upgradeCapOwner: input.tx.capOwner,
    },
    diff: compactDiff(input.diff),
    signals: input.signals.map((s) => ({ id: s.id, kind: s.kind, subject: s.subject, detail: s.detail })),
    deterministicAssessment: {
      withoutMemory: { risk: input.baseline.risk, score: input.baseline.score },
      withMemory: {
        risk: input.assessment.risk,
        score: input.assessment.score,
        effects: input.assessment.influences.map((i) => ({ memoryId: i.memoryId, effect: i.effect, reason: i.reason })),
      },
    },
    memories: input.memories.map((m) => ({ id: m.id, kind: m.tags.kind, text: m.text, status: m.status })),
  };

  bump("claudeCalls");
  try {
    const res = await c.beta.messages.create({
      model: env.anthropicModel,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Triage this upgrade. Input JSON:\n${JSON.stringify(payload)}` }],
    });
    if (res.stop_reason === "refusal") {
      bump("fallbackVerdicts");
      return fallback("Claude declined; deterministic engine used");
    }
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = validate(extractJson(text), new Set(input.memories.map((m) => m.id)));
    if (!parsed) {
      bump("fallbackVerdicts");
      return fallback("Claude output failed validation");
    }
    return {
      ...parsed,
      engine: "claude",
      model: res.model,
      score: input.assessment.score,
      breakdown: input.assessment.breakdown,
      memoriesUsed: input.memories.length,
    };
  } catch (err) {
    bump("fallbackVerdicts");
    const msg = err instanceof Anthropic.APIError ? `Claude API ${err.status}: ${err.message}` : (err as Error).message;
    return fallback(msg.slice(0, 200));
  }
}
