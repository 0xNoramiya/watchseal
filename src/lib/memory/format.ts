import type { Signal, SignalKind } from "../analysis/signals";
import { IDENTITY_KINDS, KIND_LABEL, SENSITIVE_WORDS } from "../analysis/signals";

export type MemoryKind = "baseline" | "authority" | "triage" | "rule";
export type TriageLabel = "expected" | "suspicious" | "false-positive";
export type RuleAction = "escalate" | "downgrade";

export interface MemoryTags {
  protocol: string; // slug or "*"
  kind: MemoryKind;
  label?: TriageLabel;
  sigs: SignalKind[];
  mods: string[];
  words: string[];
  kw: string[];
  act?: RuleAction;
  signer?: string;
  version?: number;
}

/** A memory as WatchSeal sees it after recall (or from the local write log). */
export interface Memory {
  id: string; // Walrus blob id (or local id while pending)
  text: string;
  tags: MemoryTags;
  createdAt?: string;
  distance?: number;
  status: "stored" | "pending";
}

const TAG_RE = /^\[([a-z][a-z0-9-]*)(?::([^\]]*))?\]/;

export function parseMemory(text: string): { tags: MemoryTags; body: string } | null {
  let rest = text.trim();
  const raw: [string, string | undefined][] = [];
  for (;;) {
    const m = TAG_RE.exec(rest);
    if (!m) break;
    raw.push([m[1], m[2]]);
    rest = rest.slice(m[0].length);
  }
  if (!raw.some(([k]) => k === "watchseal")) return null;
  const tags: MemoryTags = { protocol: "*", kind: "baseline", sigs: [], mods: [], words: [], kw: [] };
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const [k, v] of raw) {
    switch (k) {
      case "protocol":
        tags.protocol = v || "*";
        break;
      case "kind":
        if (v === "baseline" || v === "authority" || v === "triage" || v === "rule") tags.kind = v;
        break;
      case "label":
        if (v === "expected" || v === "suspicious" || v === "false-positive") tags.label = v;
        break;
      case "sig":
        tags.sigs.push(...(list(v) as SignalKind[]));
        break;
      case "mod":
        tags.mods.push(...list(v));
        break;
      case "w":
        tags.words.push(...list(v));
        break;
      case "kw":
        tags.kw.push(...list(v));
        break;
      case "act":
        tags.act = v === "downgrade" ? "downgrade" : "escalate";
        break;
      case "signer":
        tags.signer = v?.toLowerCase();
        break;
      default:
        if (/^v\d+$/.test(k)) tags.version = Number(k.slice(1));
    }
  }
  return { tags, body: rest.trim() };
}

function header(parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).map((p) => `[${p}]`).join("");
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function baselineMemory(p: { slug: string; name: string; version: number; packageId: string; modules: number; functions: number; signer?: string }): string {
  return (
    header(["watchseal", `protocol:${p.slug}`, "kind:baseline", `v${p.version}`]) +
    ` ${p.name} package ${p.packageId} at v${p.version} is the analyst-reviewed baseline with ${p.modules} modules and ${p.functions} functions` +
    (p.signer ? `, published by ${p.signer}.` : ".")
  );
}

export function capBaselineMemory(p: { slug: string; name: string; version: number; capId: string; policy: string; holder: string }): string {
  return (
    header(["watchseal", `protocol:${p.slug}`, "kind:baseline", `v${p.version}`]) +
    ` ${p.name} UpgradeCap ${p.capId} uses the ${p.policy} upgrade policy and is held by ${p.holder}.`
  );
}

export function authorityMemory(p: { slug: string; name: string; signer: string; scheme?: string; reason: string; version?: number }): string {
  return (
    header(["watchseal", `protocol:${p.slug}`, "kind:authority", `signer:${p.signer.toLowerCase()}`, p.version !== undefined && `v${p.version}`]) +
    ` ${p.signer} is a known upgrade authority for ${p.name}${p.scheme ? ` (${p.scheme})` : ""}: ${p.reason}`
  );
}

export function triageMemory(p: {
  slug: string;
  name: string;
  version: number;
  label: TriageLabel;
  signals: Signal[];
  modules: string[];
  note?: string;
}): string {
  const learnable = p.signals.filter((s) => !IDENTITY_KINDS.includes(s.kind));
  const sigs = uniq(learnable.map((s) => s.kind));
  const words = uniq(learnable.flatMap((s) => s.words ?? []));
  const mods = uniq(p.modules).sort();
  const labelText =
    p.label === "false-positive" ? "a false positive" : p.label === "expected" ? "expected" : "suspicious";
  const what = sigs.length ? sigs.map((k) => KIND_LABEL[k]).join(", ") : "no notable signals";
  const examples = learnable
    .filter((s) => s.kind !== "bytecode-only")
    .slice(0, 4)
    .map((s) => s.subject);
  const advice =
    p.label === "suspicious"
      ? "Escalate similar changes."
      : p.label === "false-positive"
        ? "Treat similar changes as noise."
        : "Similar changes are routine for this protocol.";
  return (
    header([
      "watchseal",
      `protocol:${p.slug}`,
      "kind:triage",
      `label:${p.label}`,
      sigs.length > 0 && `sig:${sigs.join(",")}`,
      mods.length > 0 && `mod:${mods.join(",")}`,
      words.length > 0 && `w:${words.join(",")}`,
      `v${p.version}`,
    ]) +
    ` Analyst marked ${p.name} v${p.version} as ${labelText}: ${what}` +
    (examples.length ? ` (e.g. ${examples.join(", ")})` : "") +
    `. ${advice}` +
    (p.note ? ` Note: ${p.note.replace(/\s+/g, " ").slice(0, 200)}` : "")
  );
}

const PHRASE_SIGS: [RegExp, SignalKind][] = [
  [/single[- ]key|non[- ]multisig|not (a )?multisig|single signer/i, "single-key-signer"],
  [/new signer|unknown signer|unknown authority|new authority/i, "signer-unknown"],
  [/upgrade ?cap|cap (moves|moved|transfer|owner)/i, "cap-owner-changed"],
  [/bytecode[- ]only|body[- ]only|bytecode change|relink/i, "bytecode-only"],
  [/new modules?/i, "module-added"],
  [/entry (fn|function)s?/i, "new-entry-fn"],
  [/visibility/i, "visibility-widened"],
  [/capabilit(y|ies)|cap types?/i, "new-cap-type"],
];

const STOP = new Set(["new", "always", "escalate", "functions", "function", "any", "the", "a", "an", "of", "in", "on", "and", "or", "to", "fn", "fns"]);

/** Builds a rule memory from free text such as "always escalate new withdraw functions". */
export function ruleMemory(text: string, protocol: { slug: string; name: string } | null, modules: string[] = []): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const act: RuleAction = /\b(ignore|downgrade|discount|noise|benign|routine|safe)\b/i.test(clean) ? "downgrade" : "escalate";
  const sigs = uniq(PHRASE_SIGS.filter(([re]) => re.test(clean)).map(([, k]) => k));
  const tokens = clean.toLowerCase().match(/`[^`]+`|[a-z0-9_]+/g) ?? [];
  const kw = uniq(
    tokens
      .map((t) => t.replace(/`/g, ""))
      .filter((t) => !STOP.has(t))
      // when the rule names a signal ("single key", "UpgradeCap moves"), only explicit identifiers become keywords
      .map((t) => (t.includes("_") ? t : sigs.length ? "" : (SENSITIVE_WORDS.find((w) => t.startsWith(w)) ?? "")))
      .filter(Boolean),
  );
  const mods = uniq(modules.filter((m) => new RegExp(`\\b${m}\\b`, "i").test(clean)));
  return (
    header([
      "watchseal",
      `protocol:${protocol?.slug ?? "*"}`,
      "kind:rule",
      `act:${act}`,
      sigs.length > 0 && `sig:${sigs.join(",")}`,
      kw.length > 0 && `kw:${kw.join(",")}`,
      mods.length > 0 && `mod:${mods.join(",")}`,
    ]) + ` Standing rule${protocol ? ` for ${protocol.name}` : ""}: ${clean}.`
  );
}

export function toMemory(m: { blob_id: string; text: string; distance?: number; created_at?: string }, status: Memory["status"] = "stored"): Memory | null {
  const parsed = parseMemory(m.text);
  if (!parsed) return null;
  return { id: m.blob_id, text: m.text, tags: parsed.tags, distance: m.distance, createdAt: m.created_at, status };
}
