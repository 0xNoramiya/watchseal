import { claudeAvailable, rateWithClaude } from "./agent/claude";
import type { Verdict } from "./agent/verdict";
import { diffPackages, diffSummary, type AbiDiff } from "./analysis/diff";
import { assess, enforceMemoryEffect, learnedBefore } from "./analysis/risk";
import { computeSignals, type Signal } from "./analysis/signals";
import { FixtureReader } from "./chain/fixture-reader";
import { TatumGrpcReader } from "./chain/grpc-reader";
import type { CapState, ChainReader, UpgradeTx } from "./chain/types";
import { shortAddr } from "./chain/types";
import { env } from "./env";
import { authorityMemory, baselineMemory, parseMemory, ruleMemory, triageMemory, type Memory, type TriageLabel } from "./memory/format";
import { MemoryStore, type MemoryLogEntry } from "./memory/store";
import { bump, counters } from "./metrics";
import { KNOWN_PROTOCOLS, slugify } from "./protocols";
import { StateStore, type Alert, type WatchedProtocol } from "./state";

export interface EngineOptions {
  reader?: ChainReader;
  memory?: MemoryStore;
  stateFile?: string;
  /** Force the deterministic engine even if an Anthropic key is present (tests). */
  noClaude?: boolean;
  settleTimeoutMs?: number;
}

export class WatchSeal {
  readonly reader: ChainReader;
  readonly memory: MemoryStore;
  readonly store: StateStore;
  private noClaude: boolean;
  private settleTimeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  /** What the engine is doing right now, polled by the UI as live progress. */
  activity: { step: string; at: string } | null = null;

  private step(step: string) {
    this.activity = { step, at: new Date().toISOString() };
  }

  constructor(opts: EngineOptions = {}) {
    this.store = new StateStore(opts.stateFile ?? env.stateFile);
    this.reader = opts.reader ?? (env.offline || !env.tatumKey ? new FixtureReader() : new TatumGrpcReader());
    this.memory = opts.memory ?? new MemoryStore({ onChange: () => this.store.save() });
    this.noClaude = !!opts.noClaude;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 60_000;
    this.ready = this.resume();
  }

  /** Re-attach to pending Walrus jobs after a restart (or rebuild the mock from the log). */
  private async resume() {
    const log = this.store.state.memoryLog.filter((e) => e.backend === this.memory.backend);
    if (this.memory.backend === "mock") await this.memory.hydrateMock(log);
    else for (const e of log) if (e.status === "pending") this.memory.track(e);
  }

  /** Serializes mutating operations so state stays consistent. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.ready;
      try {
        return await fn();
      } finally {
        this.activity = null;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  get state() {
    return this.store.state;
  }

  // ---------- memory helpers ----------

  async writeMemory(text: string, meta: Pick<MemoryLogEntry, "kind" | "protocol" | "origin">) {
    // One log row per distinct text: an identical write would resolve to the same Walrus blob anyway.
    const existing = this.state.memoryLog.find((e) => e.text === text && e.backend === this.memory.backend && e.status !== "failed");
    if (existing) return existing;
    const entry = await this.memory.write(text, meta);
    this.state.memoryLog.unshift(entry);
    this.store.save();
    return entry;
  }

  private async recallFor(p: WatchedProtocol, version: number, signals: Signal[]) {
    const inflight = this.memory.pendingCount();
    if (inflight) this.step(`Waiting for ${inflight} memory write${inflight > 1 ? "s" : ""} to land on Walrus`);
    const settled = await this.memory.settle(this.settleTimeoutMs);
    this.step(`Recalling ${p.name} memories from Walrus`);
    const kinds = [...new Set(signals.map((s) => s.kind))].join(" ");
    const subjects = signals
      .filter((s) => s.kind !== "bytecode-only")
      .slice(0, 6)
      .map((s) => s.subject.replace(/::/g, " "))
      .join(" ");
    const words = [...new Set(signals.flatMap((s) => s.words ?? []))].join(" ");
    const queries: [string, { sort?: "recent" }][] = [
      [`watchseal ${p.slug} ${p.name} triage: analyst marked upgrade with ${kinds} ${subjects}`, {}],
      [`watchseal ${p.slug} triage label expected suspicious false-positive`, { sort: "recent" }],
      [`watchseal standing rule: always escalate or ignore ${words} ${kinds}`, {}],
      [`watchseal ${p.slug} ${p.name} known upgrade authority signer`, {}],
      [`watchseal ${p.slug} ${p.name} baseline`, {}],
    ];
    const results = await Promise.all(queries.map(([q, o]) => this.memory.recall(q, { topK: 20, ...o })));
    const byText = new Map<string, Memory>();
    for (const m of results.flat()) {
      if (m.tags.protocol !== "*" && m.tags.protocol !== p.slug) continue;
      if (!byText.has(m.text)) byText.set(m.text, m);
    }
    // Writes still in flight (Walrus job not done yet) are included, clearly marked as pending.
    let pendingIncluded = 0;
    for (const e of this.state.memoryLog) {
      if (e.status !== "pending" || e.backend !== this.memory.backend || byText.has(e.text)) continue;
      const parsed = parseMemory(e.text);
      if (!parsed || (parsed.tags.protocol !== "*" && parsed.tags.protocol !== p.slug)) continue;
      byText.set(e.text, { id: e.id, text: e.text, tags: parsed.tags, status: "pending", createdAt: e.createdAt });
      pendingIncluded++;
    }
    const memories = [...byText.values()].filter((m) => learnedBefore(m, version));
    return { memories, settled, pendingIncluded };
  }

  // ---------- core analysis ----------

  private async rate(p: { name: string; slug: string }, version: number, fromVersion: number, diff: AbiDiff, signals: Signal[], baseSignals: Signal[], tx: UpgradeTx | null, memories: Memory[]) {
    const baseline = assess({ slug: p.slug, version, sender: tx?.sender ?? null, signals: baseSignals, memories: [] });
    const assessment = assess({ slug: p.slug, version, sender: tx?.sender ?? null, signals, memories });
    if (memories.length) assessment.risk = enforceMemoryEffect(assessment.risk, baseline.risk, assessment.influences);
    const input = { protocolName: p.name, slug: p.slug, version, fromVersion, diff, signals, tx, memories, assessment, baseline };
    let verdict: Verdict;
    if (this.noClaude || !claudeAvailable()) {
      const { fallbackVerdict } = await import("./agent/verdict");
      if (!this.noClaude) bump("fallbackVerdicts");
      verdict = fallbackVerdict({ protocolName: p.name, version, signals, assessment, memoriesUsed: memories.length, note: this.noClaude ? undefined : "ANTHROPIC_API_KEY not set" });
    } else {
      this.step(`Claude is rating v${version} with ${memories.length} memor${memories.length === 1 ? "y" : "ies"}`);
      verdict = await rateWithClaude(input);
      if (memories.length && verdict.engine === "claude") {
        const adjusted = enforceMemoryEffect(verdict.risk, baseline.risk, verdict.memoryInfluence);
        if (adjusted !== verdict.risk) {
          verdict.note = `level moved ${verdict.risk} -> ${adjusted} to reflect the memory effects Claude cited`;
          verdict.risk = adjusted;
        }
      }
    }
    return { verdict, baseline: { risk: baseline.risk, score: baseline.score } };
  }

  private async analyzeVersion(p: WatchedProtocol, version: number): Promise<Alert> {
    const prevV = p.versions.filter((v) => v.version < version).at(-1);
    const nextV = p.versions.find((v) => v.version === version);
    if (!prevV || !nextV) throw new Error(`${p.slug}: no v${version} or no previous version`);
    const via = this.reader.kind === "tatum" ? "via Tatum gRPC" : "from recorded history";
    this.step(`Reading v${prevV.version} and v${version} ${via}`);
    const [prev, next] = [await this.reader.getSnapshot(prevV.packageId, prevV.version), await this.reader.getSnapshot(nextV.packageId, nextV.version)];
    this.step(`Reading the v${version} upgrade transaction`);
    const [prevTx, tx] = [await this.reader.getUpgradeTx(prevV.packageId), await this.reader.getUpgradeTx(nextV.packageId)];
    this.step(`Diffing ABI and bytecode, v${prevV.version} to v${version}`);
    if (tx?.capId && !p.capId) p.capId = tx.capId;

    const diff = diffPackages(prev, next);
    const baseSignals = computeSignals(diff, { tx, prevTx, knownAuthorities: [] });
    const recall = await this.recallFor(p, version, baseSignals);
    const knownAuthorities = recall.memories.filter((m) => m.tags.kind === "authority" && m.tags.signer).map((m) => m.tags.signer!);
    const signals = computeSignals(diff, { tx, prevTx, knownAuthorities });
    const { verdict, baseline } = await this.rate(p, version, prevV.version, diff, signals, baseSignals, tx, recall.memories);

    bump("alerts");
    return {
      id: `a_${p.slug}_v${version}_${Date.now().toString(36)}`,
      slug: p.slug,
      protocolName: p.name,
      type: "upgrade",
      version,
      fromVersion: prevV.version,
      packageId: nextV.packageId,
      createdAt: new Date().toISOString(),
      tx,
      prevTx,
      diff,
      diffSummary: diffSummary(diff),
      signals,
      baseSignals,
      recalled: recall.memories,
      verdict,
      baseline,
      memorySync: { settled: recall.settled, pendingIncluded: recall.pendingIncluded },
    };
  }

  // ---------- public operations ----------

  addProtocol(input: { originalId: string; name?: string; slug?: string; mode: "replay" | "live"; startVersion?: number }) {
    return this.run(async () => {
      const known = KNOWN_PROTOCOLS.find((k) => k.originalId === input.originalId || k.slug === input.slug);
      const originalId = input.originalId || known?.originalId;
      if (!originalId) throw new Error("package id required");
      this.step(this.reader.kind === "tatum" ? "Listing package versions via Tatum gRPC" : "Listing package versions");
      const versions = await this.reader.listVersions(originalId);
      if (!versions.length) throw new Error("package has no versions");
      const name = input.name?.trim() || known?.name || `Package ${shortAddr(originalId)}`;
      const slug = input.slug?.trim() || known?.slug || slugify(name);
      const latest = versions.at(-1)!.version;
      const start =
        input.startVersion ?? (input.mode === "replay" ? (known?.replayFrom ?? Math.max(1, latest - 3)) : latest);
      const startV = versions.find((v) => v.version === start);
      if (!startV) throw new Error(`v${start} not found (latest is v${latest})`);

      const existingAt = this.state.watchlist.findIndex((w) => w.slug === slug);
      this.state.alerts = this.state.alerts.filter((a) => a.slug !== slug);
      const p: WatchedProtocol = {
        slug,
        name,
        originalId,
        capId: known?.capId ?? null,
        mode: input.mode,
        versions,
        startVersion: start,
        cursor: start,
        lastCap: null,
        addedAt: new Date().toISOString(),
      };
      // Re-adding keeps the protocol's place in the watchlist.
      if (existingAt >= 0) this.state.watchlist[existingAt] = p;
      else this.state.watchlist.push(p);

      // Baseline + the baseline signer become memories (dedupe keeps re-adds idempotent on Walrus).
      this.step(`Reading the v${start} baseline and writing it to Walrus Memory`);
      const snap = await this.reader.getSnapshot(startV.packageId, start);
      const tx = await this.reader.getUpgradeTx(startV.packageId);
      if (tx?.capId && !p.capId) p.capId = tx.capId;
      const fns = Object.values(snap.modules).reduce((n, m) => n + Object.keys(m.functions).length, 0);
      await this.writeMemory(
        baselineMemory({ slug, name, version: start, packageId: startV.packageId, modules: Object.keys(snap.modules).length, functions: fns, signer: tx?.sender }),
        { kind: "baseline", protocol: slug, origin: "baseline" },
      );
      if (tx) {
        await this.writeMemory(
          authorityMemory({ slug, name, signer: tx.sender, scheme: tx.schemes.join("+"), version: start, reason: `it signed the reviewed baseline v${start}.` }),
          { kind: "authority", protocol: slug, origin: "authority" },
        );
      }
      if (p.capId) p.lastCap = await this.reader.getCapState(p.capId);
      this.store.save();
      return p;
    });
  }

  /** Replay: analyze the next historical upgrade. */
  next(slug: string) {
    return this.run(async () => {
      const p = this.store.protocol(slug);
      const nextV = p.versions.find((v) => v.version > p.cursor);
      if (!nextV) throw new Error(`${p.name} is at the latest version (v${p.cursor})`);
      const alert = await this.analyzeVersion(p, nextV.version);
      p.cursor = nextV.version;
      this.state.alerts.unshift(alert);
      this.store.save();
      return alert;
    });
  }

  /** Live: catch up every live-mode protocol to its latest version, and check UpgradeCaps. */
  scan() {
    return this.run(async () => {
      const created: Alert[] = [];
      for (const p of this.state.watchlist.filter((w) => w.mode === "live")) {
        this.step(`Checking ${p.name} for new versions`);
        p.versions = await this.reader.listVersions(p.originalId);
        for (const v of p.versions.filter((x) => x.version > p.cursor)) {
          const alert = await this.analyzeVersion(p, v.version);
          p.cursor = v.version;
          this.state.alerts.unshift(alert);
          created.push(alert);
        }
        if (p.capId) {
          this.step(`Checking the ${p.name} UpgradeCap owner and policy`);
          const cap = await this.reader.getCapState(p.capId);
          const capAlert = this.capCheck(p, cap);
          if (capAlert) {
            this.state.alerts.unshift(await capAlert);
            created.push(this.state.alerts[0]);
          }
          p.lastCap = cap;
        }
        p.lastScanAt = new Date().toISOString();
      }
      this.store.save();
      return created;
    });
  }

  private capCheck(p: WatchedProtocol, cap: CapState): Promise<Alert> | null {
    const before = p.lastCap;
    if (!before) return null;
    const ownerMoved = (before.owner ?? "") !== (cap.owner ?? "") || before.ownerKind !== cap.ownerKind;
    const policyChanged = before.policy !== cap.policy;
    const destroyed = before.exists && !cap.exists;
    // A version bump on the cap is a normal upgrade; analyzeVersion covers it.
    if (!ownerMoved && !policyChanged && !destroyed) return null;
    return (async () => {
      const signals: Signal[] = [];
      if (destroyed) signals.push({ id: "s1", kind: "cap-destroyed", subject: cap.capId, detail: "UpgradeCap destroyed: package is now immutable", weight: 0 });
      if (ownerMoved && !destroyed)
        signals.push({ id: "s2", kind: "cap-owner-changed", subject: cap.owner ?? cap.ownerKind, detail: `UpgradeCap ${before.ownerKind} ${shortAddr(before.owner)} -> ${cap.ownerKind} ${shortAddr(cap.owner)} without an upgrade`, weight: 3 });
      if (policyChanged && !destroyed)
        signals.push({ id: "s3", kind: "cap-policy-changed", subject: cap.capId, detail: `policy ${before.policy} -> ${cap.policy}`, weight: 2 });
      const emptyDiff = diffPackages({ packageId: "", version: p.cursor, modules: {}, bytecode: {}, source: "tatum" }, { packageId: "", version: p.cursor, modules: {}, bytecode: {}, source: "tatum" });
      const recall = await this.recallFor(p, p.cursor + 1, signals);
      const { verdict, baseline } = await this.rate(p, p.cursor + 1, p.cursor, emptyDiff, signals, signals, null, recall.memories);
      bump("alerts");
      return {
        id: `a_${p.slug}_cap_${Date.now().toString(36)}`,
        slug: p.slug,
        protocolName: p.name,
        type: "cap" as const,
        version: p.cursor,
        fromVersion: p.cursor,
        packageId: cap.packageId ?? "",
        createdAt: new Date().toISOString(),
        tx: null,
        prevTx: null,
        diff: null,
        diffSummary: signals.map((s) => s.detail).join("; "),
        signals,
        baseSignals: signals,
        recalled: recall.memories,
        verdict,
        baseline,
        memorySync: { settled: recall.settled, pendingIncluded: recall.pendingIncluded },
        capChange: { before, after: cap },
      };
    })();
  }

  /** Analyst label. Writes a triage memory; approving a new signer also writes an authority memory. */
  triage(alertId: string, label: TriageLabel, note?: string) {
    return this.run(async () => {
      const a = this.store.alert(alertId);
      const p = this.store.protocol(a.slug);
      this.step("Writing the label to Walrus Memory");
      const modules = a.diff ? [...new Set([...a.diff.bytecodeChanged, ...a.diff.addedModules, ...a.signals.map((s) => s.module).filter((m): m is string => !!m)])] : [];
      const logIds: string[] = [];
      const t = await this.writeMemory(
        triageMemory({ slug: p.slug, name: p.name, version: a.version, label, signals: a.signals, modules, note }),
        { kind: "triage", protocol: p.slug, origin: "triage" },
      );
      logIds.push(t.id);
      const newSigner = a.signals.find((s) => s.kind === "signer-unknown");
      if (newSigner && label === "expected" && a.tx) {
        const auth = await this.writeMemory(
          authorityMemory({ slug: p.slug, name: p.name, signer: a.tx.sender, scheme: a.tx.schemes.join("+"), version: a.version, reason: `analyst approved it as the signer of v${a.version}.` }),
          { kind: "authority", protocol: p.slug, origin: "authority" },
        );
        logIds.push(auth.id);
      }
      a.triage = { label, note, at: new Date().toISOString(), memoryLogIds: logIds };
      this.store.save();
      return a;
    });
  }

  addRule(text: string, slug: string | null) {
    return this.run(async () => {
      if (!text.trim()) throw new Error("rule text is empty");
      const p = slug ? this.store.protocol(slug) : null;
      const modules = p ? [...new Set(this.state.alerts.filter((a) => a.slug === p.slug).flatMap((a) => (a.diff ? a.diff.bytecodeChanged : [])))] : [];
      return this.writeMemory(ruleMemory(text, p && { slug: p.slug, name: p.name }, modules), {
        kind: "rule",
        protocol: p?.slug ?? "*",
        origin: "rule",
      });
    });
  }

  /** Re-runs the same alert with zero memories: no recall, no known authorities. */
  compare(alertId: string) {
    return this.run(async () => {
      const a = this.store.alert(alertId);
      const diff = a.diff ?? diffPackages({ packageId: "", version: a.version, modules: {}, bytecode: {}, source: "tatum" }, { packageId: "", version: a.version, modules: {}, bytecode: {}, source: "tatum" });
      const baseSignals = a.baseSignals.filter((s) => s.kind !== "signer-unknown");
      this.step(`Re-running v${a.version} with zero memories`);
      const { verdict } = await this.rate({ name: a.protocolName, slug: a.slug }, a.version, a.fromVersion, diff, baseSignals, baseSignals, a.tx, []);
      a.compare = { ...verdict, at: new Date().toISOString() };
      this.store.save();
      return a;
    });
  }

  /** Free-text semantic recall against Walrus Memory, for the dashboard's memory explorer. Read-only. */
  async explore(query: string, slug?: string | null) {
    await this.ready;
    const q = query.trim().slice(0, 300);
    if (!q) throw new Error("Type a question to ask the memory.");
    const t0 = Date.now();
    const found = await this.memory.recall(`watchseal ${q}`, { topK: 12, maxDistance: this.memory.backend === "mock" ? 0.99 : 0.95 });
    const results = slug ? found.filter((m) => m.tags.protocol === "*" || m.tags.protocol === slug) : found;
    results.sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
    return { query: q, results, ms: Date.now() - t0, backend: this.memory.backend, namespace: this.memory.namespace };
  }

  /** Cross-checks the app's write log against what the Walrus Memory relayer reports for the namespace. */
  async inventory() {
    await this.ready;
    const t0 = Date.now();
    const items = await this.memory.inventory();
    if (!items) return { available: false as const, backend: this.memory.backend, namespace: this.memory.namespace };
    const onWalrus = new Set(items.map((i) => i.blobId));
    const written = this.state.memoryLog.filter((e) => e.backend === "walrus" && e.status === "stored" && e.blobId);
    const epochs = items.map((i) => i.endEpoch).filter((e): e is number => typeof e === "number");
    return {
      available: true as const,
      backend: this.memory.backend,
      namespace: this.memory.namespace,
      count: items.length,
      bytes: items.reduce((n, i) => n + (i.size || 0), 0),
      paidThroughEpoch: epochs.length ? Math.min(...epochs) : null,
      verified: written.filter((e) => onWalrus.has(e.blobId!)).map((e) => e.blobId!),
      written: written.length,
      ms: Date.now() - t0,
    };
  }

  resetProtocol(slug: string) {
    return this.run(async () => {
      const p = this.store.protocol(slug);
      p.cursor = p.startVersion;
      this.state.alerts = this.state.alerts.filter((a) => a.slug !== slug);
      this.store.save();
      return p;
    });
  }

  removeProtocol(slug: string) {
    return this.run(async () => {
      this.state.watchlist = this.state.watchlist.filter((w) => w.slug !== slug);
      this.state.alerts = this.state.alerts.filter((a) => a.slug !== slug);
      this.store.save();
    });
  }

  async status() {
    await this.ready;
    const health = await this.memory.health();
    return {
      chain: {
        mode: this.reader.kind,
        transport: this.reader.kind === "tatum" ? env.tatumTransport : null,
        host: this.reader.kind === "tatum" ? env.tatumHost : null,
      },
      memory: {
        backend: this.memory.backend,
        network: this.memory.backend === "walrus" ? "Walrus Mainnet" : "offline mock",
        credentials: this.memory.credentialSource,
        namespace: this.memory.namespace,
        healthy: health.ok,
        detail: health.detail,
        pending: this.memory.pendingCount(),
        delegatePublicKey: await this.memory.publicKey(),
      },
      agent: {
        engine: this.noClaude || !claudeAvailable() ? "fallback" : "claude",
        model: env.anthropicModel,
      },
      counters,
    };
  }

  /** Small view model for the UI. */
  view() {
    const s = this.state;
    return {
      watchlist: s.watchlist.map((w) => ({
        ...w,
        versions: undefined,
        versionCount: w.versions.length,
        latest: w.versions.at(-1)?.version ?? null,
        remaining: w.versions.filter((v) => v.version > w.cursor).length,
      })),
      alerts: s.alerts.map((a) => ({ ...a, diff: a.diff && { ...a.diff, addedFunctions: a.diff.addedFunctions.slice(0, 80) } })),
      memoryLog: s.memoryLog.filter((e) => e.backend === this.memory.backend).slice(0, 200),
      counters,
      activity: this.activity,
      memoryBackend: this.memory.backend,
    };
  }
}

const g = globalThis as unknown as { __watchseal?: WatchSeal };
export function getEngine(): WatchSeal {
  g.__watchseal ??= new WatchSeal();
  return g.__watchseal;
}
