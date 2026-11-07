/**
 * Records real Mainnet history (via Tatum gRPC, archival GraphQL for pruned txs)
 * into fixtures/<slug>.json so tests and WATCHSEAL_OFFLINE=1 can replay it.
 *
 *   npm run record-fixtures            # all known protocols
 *   npm run record-fixtures cetus-clmm # one protocol
 */
import "../src/lib/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { TatumGrpcReader } from "../src/lib/chain/grpc-reader";
import type { FixtureFile } from "../src/lib/chain/fixture-reader";
import { counters } from "../src/lib/metrics";
import { KNOWN_PROTOCOLS } from "../src/lib/protocols";

async function main() {
  const wanted = process.argv.slice(2);
  const reader = new TatumGrpcReader();
  mkdirSync("fixtures", { recursive: true });

  for (const p of KNOWN_PROTOCOLS) {
    if (wanted.length && !wanted.includes(p.slug)) continue;
    console.log(`\n# ${p.name} (${p.slug})`);
    const versions = await reader.listVersions(p.originalId);
    const from = Math.max(1, (p.replayFrom ?? 1) - 1);
    const file: FixtureFile = {
      slug: p.slug,
      name: p.name,
      originalId: p.originalId,
      recordedAt: new Date().toISOString(),
      versions,
      snapshots: {},
      txs: {},
      caps: {},
    };
    let capId = p.capId ?? null;
    for (const v of versions) {
      if (v.version < from) continue;
      const snap = await reader.getSnapshot(v.packageId, v.version);
      const tx = await reader.getUpgradeTx(v.packageId);
      file.snapshots[v.packageId] = snap;
      file.txs[v.packageId] = tx;
      capId ??= tx?.capId ?? null;
      const fns = Object.values(snap.modules).reduce((n, m) => n + Object.keys(m.functions).length, 0);
      console.log(
        `  v${v.version} ${Object.keys(snap.modules).length} mods ${fns} fns | tx ${tx?.digest.slice(0, 10)} ${
          tx?.timestampMs ? new Date(tx.timestampMs).toISOString().slice(0, 10) : "?"
        } sender ${tx?.sender.slice(0, 8)} ${tx?.schemes.join("+")} cap->${tx?.capOwner?.slice(0, 8)} [${tx?.source}]`,
      );
    }
    if (capId) {
      file.caps[capId] = await reader.getCapState(capId);
      console.log(`  cap ${capId.slice(0, 10)}: ${JSON.stringify(file.caps[capId])}`);
    }
    writeFileSync(`fixtures/${p.slug}.json`, JSON.stringify(file));
    console.log(`  wrote fixtures/${p.slug}.json`);
  }
  console.log(`\nTatum calls: ${counters.tatumCalls}, archival calls: ${counters.archivalCalls}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
