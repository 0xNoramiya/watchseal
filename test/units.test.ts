/** Unit tests for the pieces the replay test exercises only end to end. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractJson } from "../src/lib/agent/claude";
import { humanizeError } from "../src/lib/errors";
import { diffPackages } from "../src/lib/analysis/diff";
import { assess, enforceMemoryEffect, learnedBefore, levelFor } from "../src/lib/analysis/risk";
import { computeSignals, isReadOnlyName, sensitiveWords, type Signal } from "../src/lib/analysis/signals";
import { bodyToString, normalizeModule, pbValueToJson } from "../src/lib/chain/normalize";
import { isNotFound, isRateLimit, tatumCall } from "../src/lib/chain/throttle";
import type { FnSig, PackageSnapshot, UpgradeTx } from "../src/lib/chain/types";
import { DEFAULT_CONFIG, renderEchogram } from "../src/lib/echogram/render";
import { CETUS_REHEARSAL } from "../src/lib/echogram/sample";
import { authorityMemory, parseMemory, ruleMemory, toMemory, triageMemory, type Memory } from "../src/lib/memory/format";

const fn = (name: string, over: Partial<FnSig> = {}): FnSig => ({
  name,
  visibility: "public",
  isEntry: false,
  typeParams: 0,
  params: [],
  returns: [],
  ...over,
});

const snap = (version: number, modules: Record<string, FnSig[]>, bytecode: Record<string, string>): PackageSnapshot => ({
  packageId: `0x${version}`,
  version,
  source: "fixture",
  bytecode,
  modules: Object.fromEntries(
    Object.entries(modules).map(([m, fns]) => [m, { name: m, functions: Object.fromEntries(fns.map((f) => [f.name, f])), structs: {} }]),
  ),
});

const tx = (sender: string, over: Partial<UpgradeTx> = {}): UpgradeTx => ({
  digest: "d",
  timestampMs: 0,
  sender,
  schemes: ["multisig"],
  capId: "0xcap",
  capOwner: sender,
  capOwnerKind: "address",
  source: "fixture",
  ...over,
});

const mem = (text: string, id = text.slice(0, 24)): Memory => toMemory({ blob_id: id, text })!;

describe("normalize", () => {
  test("renders Move types the way an analyst reads them", () => {
    assert.equal(bodyToString({ type: 6 }), "u64");
    assert.equal(bodyToString({ type: 9, typeParameterInstantiation: [{ type: 3 }] }), "vector<u8>");
    assert.equal(
      bodyToString({ type: 10, typeName: "0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin", typeParameterInstantiation: [{ type: 11, typeParameter: 0 }] }),
      "0x2::coin::Coin<T0>",
    );
  });

  test("keeps visibility, entry and reference kinds", () => {
    const m = normalizeModule({
      name: "pool",
      functions: [{ name: "swap", visibility: 2, isEntry: true, parameters: [{ reference: 2, body: { type: 6 } }], returns: [] }],
      datatypes: [{ name: "AdminCap", abilities: [4, 3], fields: [] }],
    });
    assert.deepEqual(m.functions.swap, { name: "swap", visibility: "public", isEntry: true, typeParams: 0, params: ["&mut u64"], returns: [] });
    assert.deepEqual(m.structs.AdminCap.abilities, ["key", "store"]);
  });

  test("converts protobuf Value JSON for the UpgradeCap", () => {
    const v = { kind: { oneofKind: "structValue", structValue: { fields: { policy: { kind: { oneofKind: "numberValue", numberValue: 0 } }, package: { kind: { oneofKind: "stringValue", stringValue: "0xabc" } } } } } };
    assert.deepEqual(pbValueToJson(v), { policy: 0, package: "0xabc" });
  });
});

describe("diff", () => {
  const before = snap(1, { pool: [fn("swap"), fn("helper", { visibility: "private" })], math: [fn("mul")] }, { pool: "a", math: "m1" });
  const after = snap(
    2,
    {
      pool: [fn("swap"), fn("helper", { visibility: "public" }), fn("withdraw_all", { isEntry: true }), fn("inner", { visibility: "private" })],
      math: [fn("mul")],
      vault: [fn("open")],
    },
    { pool: "b", math: "m2", vault: "v" },
  );
  const d = diffPackages(before, after);

  test("finds new modules and new reachable functions, ignores private ones", () => {
    assert.deepEqual(d.addedModules, ["vault"]);
    assert.deepEqual(d.addedFunctions.map((f) => `${f.module}::${f.fn.name}`).sort(), ["pool::withdraw_all", "vault::open"]);
    assert.equal(d.addedPrivateCount, 1);
  });

  test("flags widened visibility", () => {
    assert.equal(d.changedFunctions.length, 1);
    assert.equal(d.changedFunctions[0].name, "helper");
    assert.ok(d.changedFunctions[0].visibilityWidened);
  });

  test("separates bytecode-only changes from ABI changes", () => {
    assert.deepEqual(d.bytecodeChanged.sort(), ["math", "pool"]);
    assert.deepEqual(d.bytecodeOnly, ["math"]);
  });
});

describe("signals", () => {
  test("sensitive words match whole tokens, not substrings", () => {
    assert.deepEqual(sensitiveWords("governance_fund_withdrawal").sort(), ["govern", "withdraw"]);
    assert.deepEqual(sensitiveWords("set_fee_rate").sort(), ["fee", "set"]);
    assert.deepEqual(sensitiveWords("capacity_left"), []);
    assert.deepEqual(sensitiveWords("asset_value"), []);
  });

  test("read-only helpers are never sensitive", () => {
    assert.ok(isReadOnlyName("is_allow_flash_loan"));
    assert.ok(isReadOnlyName("check_emergency_pause_role"));
    const d = diffPackages(snap(1, { config: [] }, {}), snap(2, { config: [fn("check_emergency_pause_role")] }, {}));
    const s = computeSignals(d, { tx: null, prevTx: null, knownAuthorities: [] });
    assert.deepEqual(s.map((x) => x.kind), ["new-public-fn"]);
  });

  test("an unknown signer can only be flagged when memory knows the authorities", () => {
    const d = diffPackages(snap(1, {}, {}), snap(2, {}, {}));
    const without = computeSignals(d, { tx: tx("0xnew"), prevTx: tx("0xold"), knownAuthorities: [] });
    const withMem = computeSignals(d, { tx: tx("0xnew"), prevTx: tx("0xold"), knownAuthorities: ["0xOLD"] });
    assert.ok(!without.some((s) => s.kind === "signer-unknown"));
    assert.ok(withMem.some((s) => s.kind === "signer-unknown"));
    assert.ok(without.some((s) => s.kind === "cap-owner-changed"), "a cap move is visible from the chain alone");
  });

  test("a single-key signer is flagged", () => {
    const d = diffPackages(snap(1, {}, {}), snap(2, {}, {}));
    const s = computeSignals(d, { tx: tx("0xa", { schemes: ["ed25519"] }), prevTx: tx("0xa"), knownAuthorities: [] });
    assert.ok(s.some((x) => x.kind === "single-key-signer"));
  });
});

describe("memory format", () => {
  test("triage memories round-trip their tags and leave identity signals out", () => {
    const signals: Signal[] = [
      { id: "s1", kind: "sensitive-fn", module: "pool", subject: "pool::flash_loan", detail: "", weight: 1.5, words: ["flash"] },
      { id: "s2", kind: "signer-unknown", subject: "0xnew", detail: "", weight: 4 },
    ];
    const text = triageMemory({ slug: "cetus-clmm", name: "Cetus CLMM", version: 10, label: "expected", signals, modules: ["pool"] });
    const { tags, body } = parseMemory(text)!;
    assert.equal(tags.kind, "triage");
    assert.equal(tags.label, "expected");
    assert.equal(tags.version, 10);
    assert.deepEqual(tags.sigs, ["sensitive-fn"]);
    assert.deepEqual(tags.words, ["flash"]);
    assert.match(body, /^Analyst marked Cetus CLMM v10 as expected/);
  });

  test("authority memories lowercase the signer", () => {
    const { tags } = parseMemory(authorityMemory({ slug: "x", name: "X", signer: "0xABCD", reason: "r", version: 3 }))!;
    assert.equal(tags.signer, "0xabcd");
    assert.equal(tags.version, 3);
  });

  test("plain-English rules become tags", () => {
    assert.match(ruleMemory("always escalate new withdraw functions", null), /\[act:escalate\]\[kw:withdraw\]/);
    assert.match(ruleMemory("Always escalate upgrades signed by a single key", null), /\[sig:single-key-signer\]/);
    assert.match(ruleMemory("ignore bytecode-only changes in config", { slug: "c", name: "C" }, ["config", "pool"]), /\[protocol:c\]\[kind:rule\]\[act:downgrade\]\[sig:bytecode-only\]\[mod:config\]/);
  });

  test("text that is not a WatchSeal memory is ignored", () => {
    assert.equal(parseMemory("The user prefers dark mode"), null);
  });
});

describe("risk", () => {
  let n = 0;
  const sig = (kind: Signal["kind"], extra: Partial<Signal> = {}): Signal => ({ id: `${kind}-${++n}`, kind, subject: kind, detail: "", weight: 1, ...extra });

  test("levels have fixed thresholds", () => {
    assert.equal(levelFor(0), "low");
    assert.equal(levelFor(2.5), "medium");
    assert.equal(levelFor(5.5), "high");
    assert.equal(levelFor(10), "critical");
  });

  test("code-surface signals alone never reach critical", () => {
    const many = Array.from({ length: 40 }, (_, i) => sig("sensitive-fn", { id: `s${i}`, weight: 1.5 }));
    const more = Array.from({ length: 40 }, (_, i) => sig("new-public-fn", { id: `p${i}`, weight: 0.5 }));
    const a = assess({ slug: "x", version: 2, sender: null, signals: [...many, ...more, sig("module-added", { weight: 2 }), sig("new-cap-type", { weight: 2 })], memories: [] });
    assert.equal(a.risk, "high");
  });

  test("the newest matching label wins", () => {
    const s = [sig("new-public-fn", { weight: 2 })];
    const older = mem("[watchseal][protocol:x][kind:triage][label:suspicious][sig:new-public-fn][v3] old", "old");
    const newer = mem("[watchseal][protocol:x][kind:triage][label:false-positive][sig:new-public-fn][v5] new", "new");
    const a = assess({ slug: "x", version: 6, sender: null, signals: s, memories: [older, newer] });
    assert.equal(a.influences.find((i) => i.effect !== "context")?.memoryId, "new");
    assert.equal(a.influences[0].effect, "downgraded");
  });

  test("a label never relabels an identity signal", () => {
    const s = [sig("signer-unknown", { weight: 4 })];
    const fp = mem("[watchseal][protocol:x][kind:triage][label:false-positive][sig:signer-unknown][v1] t", "fp");
    const a = assess({ slug: "x", version: 2, sender: "0xnew", signals: s, memories: [fp] });
    assert.ok(!a.influences.some((i) => i.memoryId === "fp"));
    assert.equal(a.breakdown[0].multiplier, 1);
  });

  test("a matching escalate rule floors the level at high", () => {
    const s = [sig("new-public-fn", { subject: "pool::governance_fund_withdrawal", weight: 0.5 })];
    const rule = mem(ruleMemory("always escalate new withdraw functions", null), "rule");
    const a = assess({ slug: "x", version: 2, sender: null, signals: s, memories: [rule] });
    assert.equal(a.risk, "high");
    assert.equal(a.influences[0].effect, "escalated");
  });

  test("memories from this version or later are ignored", () => {
    const m = (v: number) => mem(`[watchseal][protocol:x][kind:triage][label:expected][v${v}] t`, `v${v}`);
    assert.ok(learnedBefore(m(4), 5));
    assert.ok(!learnedBefore(m(5), 5));
    assert.ok(!learnedBefore(m(7), 5));
  });

  test("a net memory effect always moves the level", () => {
    assert.equal(enforceMemoryEffect("high", "high", [{ memoryId: "a", effect: "downgraded", reason: "" }]), "medium");
    assert.equal(enforceMemoryEffect("high", "high", [{ memoryId: "a", effect: "escalated", reason: "" }]), "critical");
    assert.equal(enforceMemoryEffect("low", "low", [{ memoryId: "a", effect: "downgraded", reason: "" }]), "low");
    assert.equal(enforceMemoryEffect("medium", "high", [{ memoryId: "a", effect: "context", reason: "" }]), "medium");
  });
});

describe("agent output parsing", () => {
  test("extracts JSON even when wrapped in prose", () => {
    assert.deepEqual(extractJson('{"risk":"low"}'), { risk: "low" });
    assert.deepEqual(extractJson('Here you go:\n{"risk":"high","reasons":[]}\nThanks'), { risk: "high", reasons: [] });
    assert.equal(extractJson("no json here"), null);
  });
});

describe("error classification", () => {
  test("rate limits and not-found are told apart", () => {
    assert.ok(isRateLimit(new Error("Received HTTP status code 429")));
    assert.ok(isRateLimit({ code: "RESOURCE_EXHAUSTED", message: "" }));
    assert.ok(isNotFound(new Error("NOT_FOUND: transaction pruned")));
    assert.ok(!isNotFound(new Error("Received HTTP status code 429")));
  });
});

describe("echogram", () => {
  test("is a pure function of config and data", () => {
    const a = renderEchogram(DEFAULT_CONFIG, CETUS_REHEARSAL).svg;
    const b = renderEchogram({ ...DEFAULT_CONFIG }, CETUS_REHEARSAL).svg;
    assert.equal(a, b);
    assert.notEqual(a, renderEchogram({ ...DEFAULT_CONFIG, seed: DEFAULT_CONFIG.seed + 1 }, CETUS_REHEARSAL).svg);
  });

  test("the record stops where the replay stops", () => {
    const partial = CETUS_REHEARSAL.map((p, i) => (i <= 2 ? p : { version: p.version, withMem: null, without: null }));
    const { svg, layout } = renderEchogram(DEFAULT_CONFIG, partial);
    const recordEnd = layout.left + layout.segW * 3;
    const xs = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#/g)].map((m) => Number(m[1]));
    assert.ok(xs.length > 100);
    assert.ok(Math.max(...xs) <= recordEnd + 1, "no trace is drawn on paper the replay has not reached");
  });

  test("both modes render every version label", () => {
    for (const mode of ["echogram", "survey"] as const) {
      const { svg } = renderEchogram({ ...DEFAULT_CONFIG, mode }, CETUS_REHEARSAL);
      for (const p of CETUS_REHEARSAL) assert.ok(svg.includes(`v${p.version}`), `${mode} labels v${p.version}`);
    }
  });
});

describe("error messages", () => {
  test("common backend failures say what to do", () => {
    assert.match(humanizeError(new Error("Received HTTP status code 429")), /^Tatum rate-limited/);
    assert.match(humanizeError({ code: "UNAUTHENTICATED", message: "bad key" }), /TATUM_API_KEY/);
    assert.match(humanizeError(new Error("14 UNAVAILABLE: No connection established")), /network connection/);
    assert.match(humanizeError(new Error("5 NOT_FOUND: package 0x123 not found")), /no package with that ID/);
    assert.match(humanizeError(new Error("archival GraphQL HTTP 502")), /archival Sui GraphQL/);
  });

  test("messages we already wrote pass through unchanged", () => {
    assert.equal(humanizeError(new Error("Package ID must be a 0x-prefixed hex address.")), "Package ID must be a 0x-prefixed hex address.");
  });
});

describe("tatum calls", () => {
  test("a call that never answers times out instead of hanging", async () => {
    const t0 = Date.now();
    await assert.rejects(() => tatumCall(() => new Promise(() => {}), 0, 150), /DEADLINE_EXCEEDED/);
    assert.ok(Date.now() - t0 < 2000);
  });

  test("a timed-out call is retried", async () => {
    let calls = 0;
    const result = await tatumCall(() => (++calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("ok")), 2, 150);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });
});
