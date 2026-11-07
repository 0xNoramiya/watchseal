/**
 * Smoke test for every external backend WatchSeal uses.
 *   1. Tatum Sui gRPC (Mainnet): listPackageVersions, getPackage, bytecode, upgrade tx, UpgradeCap
 *   2. Walrus Memory (Mainnet relayer): health, one remember, one recall
 *   3. Anthropic: one tiny message
 * Each section reports PASS / FAIL / SKIP. Exit code is non-zero if any section FAILs.
 */
import "../src/lib/env";
import { createHash } from "node:crypto";
import { env } from "../src/lib/env";
import { createTatumClient } from "../src/lib/chain/tatum";
import { tatumCall } from "../src/lib/chain/throttle";
import Anthropic from "@anthropic-ai/sdk";
import { MemoryStore, resolveCredentials } from "../src/lib/memory/store";

const CETUS_ORIGINAL = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const CETUS_CAP = "0x4462a572640227717cb8c60b6dd337f022743de6bc13f1fe0b7adb182d1fa274";

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: { name: string; outcome: Outcome; note: string }[] = [];
const only = process.argv.slice(2);

async function section(name: string, fn: () => Promise<string | void>, skipReason?: string) {
  if (only.length && !only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) return;
  if (skipReason) {
    results.push({ name, outcome: "SKIP", note: skipReason });
    console.log(`\n[SKIP] ${name}: ${skipReason}`);
    return;
  }
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  try {
    const note = (await fn()) ?? "";
    results.push({ name, outcome: "PASS", note: `${note} (${Date.now() - t0} ms)` });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`  error: ${msg}`);
    results.push({ name, outcome: "FAIL", note: msg.slice(0, 200) });
  }
}

async function tatum() {
  const client = createTatumClient();
  console.log(`  transport=${env.tatumTransport} host=${env.tatumHost}`);

  const { response: lv } = await tatumCall(() =>
    client.movePackageService.listPackageVersions({ packageId: CETUS_ORIGINAL, pageSize: 50 }),
  );
  const versions = lv.versions.map((v) => ({ id: v.packageId!, version: Number(v.version) }));
  console.log(`  listPackageVersions: ${versions.length} versions, latest v${versions.at(-1)?.version}`);
  if (versions.length < 2) throw new Error("expected multiple Cetus versions");

  const latest = versions.at(-1)!;
  const { response: pkg } = await tatumCall(() => client.movePackageService.getPackage({ packageId: latest.id }));
  const modules = pkg.package?.modules ?? [];
  const fnCount = modules.reduce((n, m) => n + (m.functions?.length ?? 0), 0);
  console.log(`  getPackage(v${latest.version}): ${modules.length} modules, ${fnCount} functions`);
  const pool = modules.find((m) => m.name === "pool");
  const flash = pool?.functions.find((f) => f.name === "flash_loan");
  console.log(`  pool::flash_loan visibility=${flash?.visibility} params=${flash?.parameters.length}`);

  const { response: bc } = await tatumCall(() =>
    client.ledgerService.getObject({
      objectId: latest.id,
      readMask: { paths: ["package.modules.name", "package.modules.contents", "previous_transaction"] },
    }),
  );
  const bmods = bc.object?.package?.modules ?? [];
  const sample = bmods.slice(0, 3).map((m) => {
    const h = createHash("sha256").update(m.contents ?? new Uint8Array()).digest("hex").slice(0, 12);
    return `${m.name}:${m.contents?.length ?? 0}B:${h}`;
  });
  console.log(`  bytecode: ${bmods.length} modules, e.g. ${sample.join(", ")}`);
  const digest = bc.object?.previousTransaction;
  console.log(`  previous_transaction (upgrade tx): ${digest}`);

  if (digest) {
    try {
      const { response: tx } = await tatumCall(() =>
        client.ledgerService.getTransaction({
          digest,
          readMask: { paths: ["digest", "timestamp", "transaction.sender", "signatures", "effects.changed_objects"] },
        }),
      );
      const cap = tx.transaction?.effects?.changedObjects.find((o) => o.objectType?.endsWith("::package::UpgradeCap"));
      console.log(
        `  getTransaction: sender=${tx.transaction?.transaction?.sender} schemes=${tx.transaction?.signatures
          .map((s) => s.scheme)
          .join(",")} capOwner=${cap?.outputOwner?.address}`,
      );
    } catch (err) {
      console.log(`  getTransaction: ${(err as Error).message.slice(0, 120)} (expected for pruned txs; archival fallback covers it)`);
    }
  }

  const { response: capObj } = await tatumCall(() =>
    client.ledgerService.getObject({
      objectId: CETUS_CAP,
      readMask: { paths: ["owner", "json", "object_type", "version"] },
    }),
  );
  console.log(
    `  UpgradeCap: type=${capObj.object?.objectType} ownerKind=${capObj.object?.owner?.kind} owner=${capObj.object?.owner?.address}`,
  );
  return `${versions.length} Cetus versions, ${modules.length} modules`;
}

async function walrus() {
  const store = new MemoryStore({ namespace: "watchseal-smoke" });
  console.log(`  backend=${store.backend} credentials=${store.credentialSource} namespace=${store.namespace}`);
  const h = await store.health();
  console.log(`  health: ${h.ok ? "ok" : "FAILED"} ${h.detail}`);
  if (!h.ok) throw new Error(`health failed: ${h.detail}`);
  console.log(`  delegate public key (MEMWAL_AGENT_ID): ${await store.publicKey()}`);
  const stamp = new Date().toISOString();
  const text = `[watchseal][protocol:*][kind:baseline] WatchSeal smoke test memory written at ${stamp}.`;
  const entry = await store.write(text, { kind: "baseline", protocol: "*", origin: "seed" });
  console.log(`  remember: job ${entry.jobId}`);
  await store.settle(180_000);
  if (entry.status !== "stored") throw new Error(`remember job ${entry.status}: ${entry.error ?? "timeout"}`);
  console.log(`  stored on Walrus: blob ${entry.blobId}`);
  const hits = await store.recall(`watchseal smoke test memory written at ${stamp}`, { topK: 5 });
  const found = hits.find((m) => m.text === text);
  console.log(`  recall: ${hits.length} hits, ours ${found ? `found (distance ${found.distance?.toFixed(3)})` : "NOT found"}`);
  if (!found) throw new Error("recall did not return the memory just written");
  return `blob ${entry.blobId}`;
}

async function claude() {
  const client = new Anthropic({ apiKey: env.anthropicKey });
  const res = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 2000,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with exactly: watchseal ok" }],
  });
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  console.log(`  ${res.model}: "${text}" (stop_reason ${res.stop_reason})`);
  return res.model;
}

async function main() {
  await section("Tatum Sui gRPC", tatum, env.tatumKey ? undefined : "TATUM_API_KEY not set");
  await section(
    "Walrus Memory (Mainnet relayer)",
    walrus,
    resolveCredentials() ? undefined : "no MemWal credentials (.env or ~/.memwal/credentials.json)",
  );
  await section("Anthropic", claude, env.anthropicKey ? undefined : "ANTHROPIC_API_KEY not set");

  console.log("\n--- summary ---");
  for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.name}  ${r.note}`);
  process.exitCode = results.some((r) => r.outcome === "FAIL") ? 1 : 0;
}

main();
