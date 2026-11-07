/**
 * Offline Cetus CLMM replay, v9 -> v15, over recorded Mainnet history (fixtures/cetus-clmm.json),
 * with MemWalMock and the deterministic engine. Triage script:
 *   v10 expected, v11 suspicious, rule "always escalate new withdraw functions" before v12,
 *   v12 expected, v13 false-positive, v14 must be downgraded by the v13 memory.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LEVELS } from "../src/lib/analysis/risk";
import { FixtureReader } from "../src/lib/chain/fixture-reader";
import { WatchSeal } from "../src/lib/engine";
import { parseMemory } from "../src/lib/memory/format";
import { MemoryStore } from "../src/lib/memory/store";
import type { Alert } from "../src/lib/state";

const CETUS = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const NEW_SIGNER = "0xdbfd0b17fa804c98f51d552b050fb7f850b85db96fa2a0d79e50119525814a47";
const rank = (r: string) => LEVELS.indexOf(r as (typeof LEVELS)[number]);

function makeEngine() {
  const dir = mkdtempSync(path.join(tmpdir(), "watchseal-test-"));
  return new WatchSeal({
    reader: new FixtureReader(path.join(process.cwd(), "fixtures")),
    memory: new MemoryStore({ forceMock: true, namespace: "watchseal-test" }),
    stateFile: path.join(dir, "state.json"),
    noClaude: true,
    settleTimeoutMs: 5_000,
  });
}

function row(a: Alert) {
  const inf = a.verdict.memoryInfluence
    .filter((i) => i.effect !== "context")
    .map((i) => {
      const m = a.recalled.find((r) => r.id === i.memoryId);
      const t = m ? parseMemory(m.text)!.tags : null;
      return `${i.effect}<-${t?.kind}${t?.version ? `@v${t.version}` : ""}`;
    });
  return `v${a.version}: with memory=${a.verdict.risk} (${a.verdict.score}) without=${a.compare?.risk ?? a.baseline.risk} | ${inf.join(" ")}`;
}

test("Cetus replay: memory visibly changes verdicts", async () => {
  const ws = makeEngine();
  await ws.addProtocol({ originalId: CETUS, mode: "replay", startVersion: 9 });
  const log: string[] = [];

  // v10: new signer (only detectable via the v9 authority memory), cap moved, flash loans.
  let v10 = await ws.next("cetus-clmm");
  v10 = await ws.compare(v10.id);
  log.push(row(v10));
  assert.ok(v10.signals.some((s) => s.kind === "signer-unknown"), "v10 should flag the new signer from memory");
  assert.ok(!v10.compare!.reasons.join(" ").includes("signer not a known authority"), "no signer signal without memory");
  assert.ok(v10.signals.some((s) => s.kind === "sensitive-fn" && s.subject === "pool::flash_loan"));
  assert.notEqual(v10.verdict.risk, v10.compare!.risk, "v10: with memory must differ from without memory");
  assert.ok(rank(v10.verdict.risk) > rank(v10.compare!.risk), "v10: memory escalates");
  await ws.triage(v10.id, "expected", "Planned multisig rotation announced by Cetus");
  const authority = ws.state.memoryLog.find((e) => e.kind === "authority" && e.text.includes(`signer:${NEW_SIGNER}`));
  assert.ok(authority, "approving a new-signer alert writes an authority memory");

  // v11: silent config hotfix on exploit day. The new signer is now known.
  let v11 = await ws.next("cetus-clmm");
  v11 = await ws.compare(v11.id);
  log.push(row(v11));
  assert.deepEqual(v11.diff!.bytecodeOnly, ["config"]);
  assert.equal(v11.diff!.addedFunctions.length, 0);
  assert.ok(!v11.signals.some((s) => s.kind === "signer-unknown"), "v11: signer learned from v10 approval");
  await ws.triage(v11.id, "suspicious", "Silent bytecode change on the day of the exploit");

  // Rule before v12.
  const rule = await ws.addRule("always escalate new withdraw functions", null);
  assert.match(rule.text, /\[kind:rule\]\[act:escalate\]\[kw:withdraw\]/);

  // v12: emergency + governance withdrawal surface. The rule must escalate it.
  let v12 = await ws.next("cetus-clmm");
  v12 = await ws.compare(v12.id);
  log.push(row(v12));
  const ruleHit = v12.verdict.memoryInfluence.find((i) => i.memoryId === v12.recalled.find((m) => m.tags.kind === "rule")?.id);
  assert.equal(ruleHit?.effect, "escalated", "v12: withdraw rule escalates");
  assert.ok(rank(v12.verdict.risk) > rank(v12.compare!.risk), "v12: rule moves the level");
  await ws.triage(v12.id, "expected");

  // v13: bytecode churn in every module plus emergency_unpause.
  let v13 = await ws.next("cetus-clmm");
  v13 = await ws.compare(v13.id);
  log.push(row(v13));
  assert.equal(v13.diff!.bytecodeChanged.length, 13);
  await ws.triage(v13.id, "false-positive", "Dependency relink, nothing to see");

  // v14: must be downgraded by the v13 memory.
  let v14 = await ws.next("cetus-clmm");
  v14 = await ws.compare(v14.id);
  log.push(row(v14));
  const v13mem = v14.recalled.find((m) => m.tags.kind === "triage" && m.tags.version === 13);
  assert.ok(v13mem, "v14 recalls the v13 triage memory");
  const v13inf = v14.verdict.memoryInfluence.find((i) => i.memoryId === v13mem!.id);
  assert.equal(v13inf?.effect, "downgraded", "v14: v13 false-positive memory downgrades");
  assert.notEqual(v14.verdict.risk, v14.compare!.risk, "v14: with memory must differ from without memory");
  assert.ok(rank(v14.verdict.risk) < rank(v14.compare!.risk), "v14: memory downgrades");
  await ws.triage(v14.id, "expected");

  // v15 runs cleanly to the end of history.
  let v15 = await ws.next("cetus-clmm");
  v15 = await ws.compare(v15.id);
  log.push(row(v15));
  await assert.rejects(() => ws.next("cetus-clmm"), /latest version/);

  // Learning is recorded as memories: baseline + authority, 5 triage labels, 1 learned authority, 1 rule.
  assert.equal(ws.state.memoryLog.length, 9);
  console.log("\n" + log.join("\n"));
});

test("a label never feeds back into its own version", async () => {
  const ws = makeEngine();
  await ws.addProtocol({ originalId: CETUS, mode: "replay", startVersion: 13 });
  const v14 = await ws.next("cetus-clmm");
  await ws.triage(v14.id, "false-positive");
  await ws.resetProtocol("cetus-clmm");
  const again = await ws.next("cetus-clmm");
  assert.equal(again.version, 14);
  assert.ok(!again.recalled.some((m) => m.tags.kind === "triage" && m.tags.version === 14));
  assert.equal(again.verdict.risk, v14.verdict.risk);
});

test("live scan alerts when the UpgradeCap moves without an upgrade", async () => {
  class MovingCapReader extends FixtureReader {
    moved = false;
    async getCapState(capId: string) {
      const cap = await super.getCapState(capId);
      return this.moved ? { ...cap, owner: "0x000000000000000000000000000000000000000000000000000000000000beef" } : cap;
    }
  }
  const reader = new MovingCapReader(path.join(process.cwd(), "fixtures"));
  const dir = mkdtempSync(path.join(tmpdir(), "watchseal-test-"));
  const ws = new WatchSeal({
    reader,
    memory: new MemoryStore({ forceMock: true, namespace: "watchseal-cap-test" }),
    stateFile: path.join(dir, "state.json"),
    noClaude: true,
    settleTimeoutMs: 5_000,
  });
  await ws.addProtocol({ originalId: CETUS, mode: "live" }); // starts at latest, nothing to catch up
  assert.equal((await ws.scan()).length, 0, "no alert while nothing changed");
  await ws.addRule("Always escalate when the UpgradeCap moves to a new owner", null);
  reader.moved = true;
  const [capAlert] = await ws.scan();
  assert.equal(capAlert.type, "cap");
  assert.ok(capAlert.signals.some((s) => s.kind === "cap-owner-changed"));
  assert.equal(capAlert.verdict.risk, "high", "cap move plus a matching rule is at least high");
  assert.equal((await ws.scan()).length, 0, "the new owner becomes the reference after one alert");
});
