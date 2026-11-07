# Demo script (3 minutes)

Replays real Cetus CLMM history, v9 to v15, and shows memory changing verdicts.

## Before recording

- `.env` has `TATUM_API_KEY` and `ANTHROPIC_API_KEY`, plus `MEMWAL_ACCOUNT_ID` and `MEMWAL_PRIVATE_KEY` (or you are logged in with the Walrus Memory plugin).
- `npm run smoke` passes all three sections.
- `npm run seed-memory` has run, so the starting memories are on Walrus Mainnet.
- For a clean take, delete `data/state.json`, set a fresh `MEMWAL_NAMESPACE` (for example `watchseal-demo-3`) and run `npm run seed-memory` again. A fresh namespace keeps labels from earlier takes out of the recording.
- Run `npm run dev` and open http://localhost:3000 in a 1600 x 1000 window. In the dashboard, the top bar should show three green dots for Tatum Sui gRPC, Walrus Mainnet and Claude.

Keyboard shortcuts keep the take tight. Press `?` in the dashboard for the list. **N** pulls the next upgrade, **E**, **S** and **F** label it expected, suspicious or false positive, **C** compares without memory, and **J** and **K** move between alerts. They are ignored while you type in a field.

## Script

**0:00 The problem (15s).** Show `docs/title-card.jpg` for two seconds, then the landing page. Scroll once past the Cetus learning curve and click Open the dashboard.
Say: "Detecting a Sui upgrade is easy. Judging it is not. On 22 May 2025, the day of the Cetus exploit, Cetus shipped an upgrade with zero ABI change. WatchSeal learns how you triage upgrades and keeps what it learns in Walrus Memory."

**0:15 Add Cetus (15s).** Click Add protocol, then "Cetus CLMM from v9", then Start watching. The Tatum call counter ticks up as the package is read over Tatum's Sui gRPC gateway. The memory column already lists the starting memories with their Walrus blob ids: the v9 baseline, the v9 signer and the standing rules.

**0:30 v10, a new signer (35s).** Press N. The verdict is critical: flash loans, a signer that is not the known one, and the UpgradeCap moved. Open the Transaction tab to show the multisig scheme and the "archival GraphQL" source, because full nodes have pruned this transaction. Press C. The hollow marker lands in High and the gauge reads "Memory raised the risk 1 level".
Say: "Without memory, WatchSeal has no way to know this signer is new."
Click "Expected, trust signer". Two memories are written, a triage label and a new known signer.

**1:05 v11, the exploit-day hotfix (20s).** Press N. It's a bytecode-only change in `config`, the signer is now known, and it's rated low. Type the note "Silent config change on exploit day" and click Suspicious.

**1:25 A rule (10s).** In Standing rules, type "Always escalate new withdraw functions" and click Save rule.

**1:35 v12 (25s).** Press N. 38 new functions, rated critical. Memory influence shows the rule raising the risk because of `pool::governance_fund_withdrawal`. Press C to show it would be high without memory. Click Expected.

**2:00 v13 (15s).** Press N. Bytecode churn in all 13 modules plus `emergency_unpause`. The earlier "expected" labels already pull it down to low. Click False positive, since it's dependency relink noise.

**2:15 v14, the payoff (25s).** Press N. Rated low. Press C. The hollow marker lands in High and the gauge reads "Memory lowered the risk 2 levels". Memory influence cites the v13 false-positive memory and links its Walrus blob.
Say: "Six upgrades in, it has learned what this team calls noise, and it still escalates what we told it to watch."

**2:40 Close (20s).** Point at the upgrade history strip. The dark trace drops into the abyss at v10 and v12 and rises to the surface as the labels pile up, while the faint second echo shows where each verdict would have been without memory. Open "Ask the memory" and click "Who is allowed to upgrade Cetus?". A live semantic recall from Walrus returns the two trusted signers, nearest first.
Say: "WatchSeal. Tatum for the chain, Walrus for the memory."

## How the published video was made

The video in the [v0.1.0 release](https://github.com/0xNoramiya/watchseal/releases/tag/v0.1.0) follows this script, recorded by `scripts/video/record-demo.mjs` against a production build with live Tatum, Walrus Memory and Claude, in a freshly seeded namespace. The script logs a timestamp for every beat. `scripts/video/make_cut.py` then keeps the actions at normal speed, fast-forwards the waits for Walrus and Claude (with an on-screen badge), adds the captions, and adds the title and end cards.

In that take, v14 came out medium rather than low. The v13 and v12 labels lowered it, and the v11 "suspicious" label on the `config` change raised it again, so a label the analyst added on a hunch at v11 still matters three upgrades later. The captions describe that run as it happened.

## If something goes wrong on camera

- **A memory write stays pending.** The next alert still includes it, marked "still writing to Walrus".
- **Claude is slow or declines.** The deterministic engine rates the alert with the same memories, and the alert header says "Fallback engine".
- **Tatum rate-limits a burst.** Calls retry with backoff on their own. Wait a second before the next click.
