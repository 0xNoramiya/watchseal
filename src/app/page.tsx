import Link from "next/link";
import type { CSSProperties } from "react";
import echogramConfig from "@/lib/echogram/config.json";
import { renderEchogram, type EchogramConfig } from "@/lib/echogram/render";
import { CETUS_REHEARSAL } from "@/lib/echogram/sample";
import EchogramReveal from "./echogram-reveal";
import { SfxClicks, SoundToggle } from "./landing-sound";
import LiveCounters from "./live-counters";
import "./landing.css";

export const metadata = {
  title: "WatchSeal",
  description: "A Sui upgrade watchdog that learns what your team calls noise. Tatum gRPC for the chain, Walrus Memory for what it learns.",
};

const CALLOUTS: Record<number, string> = {
  10: "A new multisig signed it. Memory knew the old one, so it rates critical.",
  12: "A withdraw rule you typed matched governance_fund_withdrawal.",
  14: "You called v13 noise. Same pattern, so it rates low.",
};

const ROWS = [
  { v: "v10", what: "Flash loans, a new signer, the UpgradeCap moved", without: "high", with: "critical", why: "v9 signer memory: this one is new" },
  { v: "v11", what: "Exploit-day hotfix: config bytecode only", without: "low", with: "low", why: "Analyst flags it suspicious anyway" },
  { v: "v12", what: "38 new functions, governance_fund_withdrawal", without: "high", with: "critical", why: "Rule: always escalate new withdraw functions" },
  { v: "v13", what: "Bytecode churn in all 13 modules", without: "high", with: "low", why: "v12 and v10 were labeled expected" },
  { v: "v14", what: "create_pool_v3, is_allowed_coin_v2", without: "high", with: "low", why: "v13 was labeled a false positive" },
  { v: "v15", what: "check_emergency_unpause_role", without: "medium", with: "low", why: "v14 and v13 labels" },
];

export default function Landing() {
  const { svg, layout } = renderEchogram(echogramConfig as EchogramConfig, CETUS_REHEARSAL, 1040);
  const SWEEP_S = 2.6; // must match l-sweep in landing.css
  const frac = (version: number) => {
    const i = CETUS_REHEARSAL.findIndex((p) => p.version === version);
    return (layout.left + (i + 0.5) * layout.segW) / layout.width;
  };
  const moved = ROWS.filter((r) => r.with !== r.without).length;

  return (
    <main className="landing">
      <header className="l-hero">
        <div className="l-hero-art">
          <img src="/cover.jpg" alt="A harbor seal keeps watch above four depth bands; one sounding reaches the abyss." width={1600} height={905} />
          {/* the one sounding that reaches the abyss */}
          <span className="l-ping" aria-hidden />
        </div>
        <nav className="l-nav">
          <span className="l-mark">
            <img src="/seal.svg" alt="" width={28} height={28} /> WatchSeal
          </span>
          <span className="l-nav-right">
            <SoundToggle />
            <Link href="/dashboard" data-sfx="blub">
              Open the dashboard
            </Link>
          </span>
        </nav>
        <div className="l-hero-copy">
          <h1 style={{ "--i": 0 } as CSSProperties}>The upgrade watchdog that learns what your team calls noise.</h1>
          <p style={{ "--i": 1 } as CSSProperties}>
            WatchSeal diffs every Sui package upgrade, has Claude rate the risk, and keeps your labels, rules and trusted signers in Walrus
            Memory. The next verdict is different because of them.
          </p>
          <div className="l-ctas" style={{ "--i": 2 } as CSSProperties}>
            <Link className="l-btn primary" href="/dashboard" data-sfx="blub">
              Open the dashboard
            </Link>
            <a className="l-btn" href="#cetus" data-sfx="blub">
              Watch it learn on Cetus
            </a>
          </div>
        </div>
      </header>

      <section className="l-section" id="cetus">
        <h2>Six real upgrades, one learning curve</h2>
        <p className="l-lede">
          Cetus CLMM, v9 to v15, replayed on 7 November 2026 against Sui Mainnet. Read it like an echo-sounder recording. The dark
          bottom echo is each verdict with memory, and deeper is riskier. The faint second echo is the same upgrade rated with zero memories.
          Memory changed {moved} of {ROWS.length} verdicts.
        </p>
        <figure className="l-echogram">
          <EchogramReveal>
            <div className="l-callouts" aria-hidden>
              {Object.entries(CALLOUTS).map(([v, text]) => (
                <span key={v} style={{ left: `${frac(Number(v)) * 100}%`, "--delay": `${(frac(Number(v)) * SWEEP_S).toFixed(2)}s` } as CSSProperties}>
                  <b>v{v}</b> {text}
                </span>
              ))}
            </div>
            <div className="l-paper-scroll">
              <div className="l-paper">
                <div dangerouslySetInnerHTML={{ __html: svg }} />
                <span className="l-stylus" aria-hidden />
              </div>
            </div>
          </EchogramReveal>
          <figcaption>
            Hand-written marks are the analyst&apos;s labels. Small arches are the memories that moved a verdict.
          </figcaption>
        </figure>

        <div className="l-table-wrap">
          <table className="l-table">
            <thead>
              <tr>
                <th scope="col">Upgrade</th>
                <th scope="col">What changed</th>
                <th scope="col">Without memory</th>
                <th scope="col">With memory</th>
                <th scope="col">Because</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.v} className={r.with !== r.without ? "moved" : ""}>
                  <th scope="row">{r.v}</th>
                  <td>{r.what}</td>
                  <td>
                    <span className={`l-risk l-${r.without}`}>{r.without}</span>
                  </td>
                  <td>
                    <span className={`l-risk l-${r.with}`}>{r.with}</span>
                  </td>
                  <td>{r.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="l-section">
        <h2>How a verdict is made</h2>
        <ol className="l-flow">
          <li>
            <h3>Read the chain through Tatum</h3>
            <p>
              Native gRPC to Tatum&apos;s Sui Mainnet gateway: <code>ListPackageVersions</code>, <code>GetPackage</code>,{" "}
              <code>GetObject</code> for bytecode and the UpgradeCap, <code>GetTransaction</code> for the signer. Pruned 2025 transactions
              fall back to archival GraphQL, and the UI says which source answered.
            </p>
          </li>
          <li>
            <h3>Diff without memory</h3>
            <p>
              Move ABI and per-module bytecode hashes between versions become signals: sensitive new functions, widened visibility, new
              capability types, bytecode-only changes, single-key signers, UpgradeCap moves.
            </p>
          </li>
          <li>
            <h3>Recall from Walrus</h3>
            <p>
              Five recall queries per alert: the change itself, recent labels, standing rules, known signers, the baseline. Writes still in
              flight are awaited first, so a label you just gave counts on the very next alert.
            </p>
          </li>
          <li>
            <h3>Claude rates it, citing memories</h3>
            <p>
              Structured output with every memory that moved the verdict, by id. Only ids that were passed in can be cited. If Claude is
              unavailable, a deterministic engine applies the same memories the same way.
            </p>
          </li>
          <li>
            <h3>Your label becomes a memory</h3>
            <p>
              Expected, suspicious or false positive, written to Walrus as one plain sentence. Approving a new signer adds it as a known
              authority. Rules you type are memories too.
            </p>
          </li>
        </ol>
      </section>

      <section className="l-section l-split">
        <div>
          <h2>Memory you can audit</h2>
          <p>
            Every lesson is a sentence behind a tag header, embedded and SEAL-encrypted by the Walrus Memory relayer and stored as a
            Walrus blob. The dashboard links each memory that moved a verdict to its blob, and you can ask the memory directly: "who is allowed to upgrade Cetus?" is a semantic recall, not a keyword search. It also checks every memory it wrote against the relayer&apos;s own inventory, so &quot;stored on Walrus&quot; is something you can verify.
          </p>
          <pre className="l-memory">
            <span className="tag">[watchseal][protocol:cetus-clmm][kind:triage][label:false-positive][sig:bytecode-only,new-public-fn][v13]</span>
            {"\n"}Analyst marked Cetus CLMM v13 as a false positive: sensitive new function, new public function, bytecode-only change. Treat
            similar changes as noise.
          </pre>
        </div>
        <div>
          <h3 className="l-live-title">Live from this instance</h3>
          <LiveCounters />
        </div>
      </section>

      <section className="l-section">
        <h2>Guardrails, because memory can be wrong</h2>
        <ul className="l-guard">
          <li>
            <h3>Labels never launder a signer</h3>
            <p>
              &quot;Expected&quot; on one upgrade can&apos;t make a different signer trusted later. Unknown signers, single-key signers and
              UpgradeCap moves are only cleared by an explicit authority memory.
            </p>
          </li>
          <li>
            <h3>No time travel</h3>
            <p>Only memories learned before the alerted version count, so replaying history never leaks the future into the past.</p>
          </li>
          <li>
            <h3>Compare without memory, any time</h3>
            <p>One click re-runs the same alert with zero memories. The depth gauge shows both verdicts and how far memory moved it.</p>
          </li>
        </ul>
      </section>

      <footer className="l-footer">
        <p>
          Built for Total Recall (Tatum x Walrus), November 2026. Chain reads via Tatum Sui gRPC, lessons kept in Walrus Memory, verdicts
          by Claude.
        </p>
        <Link className="l-btn primary" href="/dashboard" data-sfx="blub">
          Open the dashboard
        </Link>
      </footer>
      <SfxClicks />
    </main>
  );
}
