import type { UpgradeTx } from "../chain/types";
import { shortAddr } from "../chain/types";
import type { AbiDiff } from "./diff";

export type SignalKind =
  | "module-added"
  | "module-removed"
  | "fn-removed"
  | "new-public-fn"
  | "new-entry-fn"
  | "sensitive-fn"
  | "visibility-widened"
  | "new-cap-type"
  | "struct-changed"
  | "bytecode-only"
  | "signer-unknown"
  | "single-key-signer"
  | "cap-owner-changed"
  | "cap-policy-changed"
  | "cap-destroyed";

export interface Signal {
  id: string;
  kind: SignalKind;
  module?: string;
  subject: string; // e.g. "pool::flash_loan" or "0xdbfd…4a47"
  detail: string;
  weight: number;
  /** Sensitive vocabulary hits in the subject (for sensitive-fn and rule matching). */
  words?: string[];
}

/** Identity signals can only be cleared by authority memories, never by a triage label. */
export const IDENTITY_KINDS: SignalKind[] = ["signer-unknown", "single-key-signer", "cap-owner-changed", "cap-policy-changed"];

export const KIND_LABEL: Record<SignalKind, string> = {
  "module-added": "new module",
  "module-removed": "module removed",
  "fn-removed": "function removed",
  "new-public-fn": "new public function",
  "new-entry-fn": "new entry function",
  "sensitive-fn": "sensitive new function",
  "visibility-widened": "visibility widened",
  "new-cap-type": "new capability type",
  "struct-changed": "struct layout changed",
  "bytecode-only": "bytecode-only change",
  "signer-unknown": "signer not a known authority",
  "single-key-signer": "single-key signer",
  "cap-owner-changed": "UpgradeCap moved",
  "cap-policy-changed": "UpgradeCap policy changed",
  "cap-destroyed": "UpgradeCap destroyed",
};

// [word, match mode]: "exact" token, "prefix" token, or "lead" (name starts with it)
const SENSITIVE: [string, "exact" | "prefix" | "lead"][] = [
  ["withdraw", "prefix"],
  ["mint", "prefix"],
  ["burn", "prefix"],
  ["flash", "prefix"],
  ["emergency", "prefix"],
  ["pause", "exact"],
  ["unpause", "exact"],
  ["govern", "prefix"],
  ["admin", "prefix"],
  ["cap", "exact"],
  ["set", "lead"],
  ["fee", "exact"],
  ["fees", "exact"],
  ["upgrade", "prefix"],
  ["oracle", "prefix"],
  ["treasury", "prefix"],
  ["migrat", "prefix"],
  ["owner", "prefix"],
  ["role", "exact"],
  ["authority", "prefix"],
  ["whitelist", "prefix"],
  ["blacklist", "prefix"],
  ["allowlist", "prefix"],
  ["denylist", "prefix"],
  ["claim", "prefix"],
  ["collect", "exact"],
  ["malicious", "exact"],
  ["cut", "exact"],
  ["restore", "prefix"],
  ["rescue", "prefix"],
  ["sweep", "prefix"],
  ["drain", "prefix"],
  ["inject", "prefix"],
  ["liquidat", "prefix"],
  ["price", "exact"],
];

export const SENSITIVE_WORDS = SENSITIVE.map(([w]) => w);

/** Read-only helpers (getters, assertions) are never "sensitive" even if they mention a sensitive word. */
const READ_ONLY_PREFIXES = ["get_", "is_", "check_", "has_", "borrow_", "calculate_", "view_", "fetch_"];

export function isReadOnlyName(name: string): boolean {
  return READ_ONLY_PREFIXES.some((p) => name.startsWith(p));
}

export function sensitiveWords(name: string): string[] {
  const lower = name.toLowerCase();
  const tokens = lower.split("_").filter(Boolean);
  const hits = new Set<string>();
  for (const [w, mode] of SENSITIVE) {
    if (mode === "lead" ? lower.startsWith(`${w}_`) : tokens.some((t) => (mode === "exact" ? t === w : t.startsWith(w)))) {
      hits.add(w);
    }
  }
  return [...hits];
}

const CAP_TYPE = /(Cap|Capability|AdminCap|OwnerCap|Admin|Authority|Owner)$/;
const SENSITIVE_MODULES = new Set(["config", "acl", "admin", "governance", "treasury", "access", "auth", "roles"]);

export interface SignalContext {
  tx: UpgradeTx | null;
  prevTx: UpgradeTx | null;
  /** Known upgrade authorities recalled from memory. Empty means "unknown", not "none allowed". */
  knownAuthorities: string[];
}

export function computeSignals(diff: AbiDiff, ctx: SignalContext): Signal[] {
  const out: Signal[] = [];
  let n = 0;
  const add = (s: Omit<Signal, "id">) => out.push({ ...s, id: `s${++n}` });

  for (const m of diff.addedModules) add({ kind: "module-added", module: m, subject: m, detail: `new module ${m}`, weight: 1.5 });
  for (const m of diff.removedModules)
    add({ kind: "module-removed", module: m, subject: m, detail: `module ${m} removed`, weight: 4 });
  for (const f of diff.removedFunctions)
    add({
      kind: "fn-removed",
      module: f.module,
      subject: `${f.module}::${f.name}`,
      detail: `${f.visibility} fn removed`,
      weight: 3,
    });

  for (const { module, fn } of diff.addedFunctions) {
    if (fn.visibility === "friend" && !fn.isEntry) continue; // package-internal, not externally callable
    const subject = `${module}::${fn.name}`;
    const words = isReadOnlyName(fn.name) ? [] : sensitiveWords(fn.name);
    const shape = `${fn.visibility}${fn.isEntry ? " entry" : ""} fn(${fn.params.join(", ")})`;
    if (words.length) add({ kind: "sensitive-fn", module, subject, detail: `${shape} [${words.join(", ")}]`, weight: 1.5, words });
    else if (fn.isEntry) add({ kind: "new-entry-fn", module, subject, detail: shape, weight: 1 });
    else add({ kind: "new-public-fn", module, subject, detail: shape, weight: 0.5 });
  }

  for (const c of diff.changedFunctions) {
    if (c.visibilityWidened || c.entryAdded) {
      const words = sensitiveWords(c.name);
      add({
        kind: "visibility-widened",
        module: c.module,
        subject: `${c.module}::${c.name}`,
        detail: `${c.before.visibility}${c.before.isEntry ? " entry" : ""} -> ${c.after.visibility}${c.after.isEntry ? " entry" : ""}`,
        weight: 2,
        words,
      });
    }
  }

  for (const { module, s } of diff.addedStructs) {
    if (s.abilities.includes("key") && CAP_TYPE.test(s.name)) {
      add({
        kind: "new-cap-type",
        module,
        subject: `${module}::${s.name}`,
        detail: `new key type {${s.abilities.join(", ")}}`,
        weight: 2,
        words: ["cap"],
      });
    }
  }
  for (const c of diff.changedStructs)
    add({
      kind: "struct-changed",
      module: c.module,
      subject: `${c.module}::${c.name}`,
      detail: "fields or abilities changed",
      weight: 2,
    });

  for (const m of diff.bytecodeOnly) {
    add({
      kind: "bytecode-only",
      module: m,
      subject: m,
      detail: `bytecode changed in ${m} with identical ABI`,
      weight: SENSITIVE_MODULES.has(m) ? 1.5 : 0.75,
    });
  }

  const { tx, prevTx, knownAuthorities } = ctx;
  if (tx) {
    const known = knownAuthorities.map((a) => a.toLowerCase());
    if (known.length && !known.includes(tx.sender.toLowerCase())) {
      add({
        kind: "signer-unknown",
        subject: tx.sender,
        detail: `signer ${shortAddr(tx.sender)} is not among ${known.length} known authorities`,
        weight: 4,
      });
    }
    if (tx.schemes.length && !tx.schemes.includes("multisig")) {
      add({ kind: "single-key-signer", subject: tx.sender, detail: `signed with ${tx.schemes.join("+")}`, weight: 3 });
    }
    if (prevTx?.capOwner && tx.capOwner && prevTx.capOwner.toLowerCase() !== tx.capOwner.toLowerCase()) {
      add({
        kind: "cap-owner-changed",
        subject: tx.capOwner,
        detail: `UpgradeCap owner ${shortAddr(prevTx.capOwner)} -> ${shortAddr(tx.capOwner)}`,
        weight: 3,
      });
    }
  }
  return out;
}
