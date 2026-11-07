/**
 * Seeds Walrus Memory (Mainnet) with the analyst's starting knowledge for Cetus CLMM and DeepBook:
 * reviewed baselines, known upgrade authorities, UpgradeCap baselines, and standing rules.
 * Chain facts come live from Tatum gRPC. Every write is awaited and its Walrus blob id printed.
 *
 *   npm run seed-memory
 *
 * The "always escalate new withdraw functions" rule is deliberately NOT seeded: the demo adds it live.
 */
import "../src/lib/env";
import { WatchSeal } from "../src/lib/engine";
import { capBaselineMemory } from "../src/lib/memory/format";
import { POLICY_NAMES } from "../src/lib/chain/types";
import { KNOWN_PROTOCOLS } from "../src/lib/protocols";

const RULES: [string, string | null][] = [
  ["Always escalate upgrades signed by a single key instead of a multisig", null],
  ["Always escalate when the UpgradeCap moves to a new owner", null],
  ["Escalate visibility widening of existing functions", null],
  ["Escalate new oracle functions", null],
  ["Escalate any new function that can mint or touch the treasury", "deepbook"],
  ["Escalate new liquidation functions", "deepbook"],
];

async function main() {
  const ws = new WatchSeal({ settleTimeoutMs: 240_000 });
  const status = await ws.status();
  console.log(`memory backend: ${status.memory.backend} (${status.memory.network}), credentials: ${status.memory.credentials}`);
  console.log(`delegate public key (MEMWAL_AGENT_ID): ${status.memory.delegatePublicKey ?? "n/a"}`);
  console.log(`chain reader: ${status.chain.mode}`);
  if (status.memory.backend !== "walrus") {
    console.log("\nNo MemWal credentials: set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID, or log in with the Walrus Memory plugin.");
    if (!process.argv.includes("--allow-mock")) process.exit(1);
  }

  for (const k of KNOWN_PROTOCOLS) {
    console.log(`\n# ${k.name}: baseline + authority at v${k.replayFrom}`);
    const p = await ws.addProtocol({ originalId: k.originalId, mode: "replay", startVersion: k.replayFrom });
    if (p.capId && p.lastCap) {
      const cap = p.lastCap;
      const startV = p.versions.find((v) => v.version === p.startVersion)!;
      const baseTx = await ws.reader.getUpgradeTx(startV.packageId);
      const text = capBaselineMemory({
        slug: p.slug,
        name: p.name,
        version: p.startVersion,
        capId: cap.capId,
        policy: POLICY_NAMES[cap.policy ?? 0] ?? String(cap.policy),
        holder: baseTx?.capOwner ?? cap.owner ?? cap.ownerKind,
      });
      await ws.writeMemory(text, { kind: "baseline", protocol: p.slug, origin: "seed" });
    }
  }

  console.log("\n# standing rules");
  for (const [text, slug] of RULES) await ws.addRule(text, slug);

  console.log("\nwaiting for Walrus jobs (embed + encrypt + upload)...");
  const done = await ws.memory.settle(300_000);
  ws.store.save(true);
  const log = ws.state.memoryLog;
  for (const e of [...log].reverse()) {
    console.log(`${e.status.padEnd(7)} ${e.blobId ?? e.error ?? e.jobId ?? ""}  ${e.text.slice(0, 110)}`);
  }
  const stored = log.filter((e) => e.status === "stored").length;
  console.log(`\n${stored}/${log.length} memories stored${done ? "" : " (some still pending)"}.`);
  process.exit(stored === log.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
