import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MemWal, MemWalMock } from "@mysten-incubation/memwal";
import { env } from "../env";
import { bump } from "../metrics";
import { toMemory, type Memory, type MemoryKind } from "./format";

export interface MemoryLogEntry {
  id: string;
  text: string;
  kind: MemoryKind;
  protocol: string;
  origin: "seed" | "triage" | "rule" | "authority" | "baseline";
  status: "pending" | "stored" | "failed";
  backend: "walrus" | "mock";
  jobId?: string;
  blobId?: string;
  error?: string;
  createdAt: string;
  storedAt?: string;
}

type Client = MemWal | MemWalMock;

interface Credentials {
  key: string;
  accountId: string;
  serverUrl: string;
  source: "env" | "memwal-plugin";
}

/** MemWal keys from .env, or from the Walrus Memory Claude Code plugin login (~/.memwal/credentials.json). */
export function resolveCredentials(): Credentials | null {
  if (env.memwalKey && env.memwalAccount) {
    return { key: env.memwalKey, accountId: env.memwalAccount, serverUrl: env.memwalServer, source: "env" };
  }
  const file = path.join(homedir(), ".memwal", "credentials.json");
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    const key = c.delegatePrivateKey ?? c.privateKey ?? c.key;
    const accountId = c.accountId ?? c.account_id;
    if (!key || !accountId) return null;
    return { key, accountId, serverUrl: c.relayerUrl ?? c.serverUrl ?? env.memwalServer, source: "memwal-plugin" };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MemoryStore {
  readonly backend: "walrus" | "mock";
  readonly credentialSource: Credentials["source"] | "none";
  readonly namespace: string;
  private client: Client;
  private inflight = new Map<string, Promise<void>>();
  private onChange: (e: MemoryLogEntry) => void;

  constructor(opts: { forceMock?: boolean; namespace?: string; onChange?: (e: MemoryLogEntry) => void } = {}) {
    this.namespace = opts.namespace ?? env.memwalNamespace;
    this.onChange = opts.onChange ?? (() => {});
    const creds = opts.forceMock || env.memwalMock ? null : resolveCredentials();
    if (creds) {
      this.client = MemWal.create({
        key: creds.key,
        accountId: creds.accountId,
        serverUrl: creds.serverUrl,
        namespace: this.namespace,
        recallTimeoutMs: 30_000,
      });
      this.backend = "walrus";
      this.credentialSource = creds.source;
    } else {
      this.client = MemWalMock.create({ namespace: this.namespace });
      this.backend = "mock";
      this.credentialSource = "none";
    }
  }

  /** Replays stored log entries into the in-process mock so a restart does not forget them. */
  async hydrateMock(entries: MemoryLogEntry[]) {
    if (this.backend !== "mock") return;
    for (const e of entries) {
      if (e.status === "failed") continue;
      const r = await this.client.rememberAndWait(e.text, { dedupe: true });
      e.blobId = r.blob_id;
      e.status = "stored";
    }
  }

  /** Submits a memory. Returns immediately with a pending log entry; the Walrus job completes in the background. */
  async write(text: string, meta: Pick<MemoryLogEntry, "kind" | "protocol" | "origin">): Promise<MemoryLogEntry> {
    const entry: MemoryLogEntry = {
      id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text,
      ...meta,
      status: "pending",
      backend: this.backend,
      createdAt: new Date().toISOString(),
    };
    bump("memoryWrites");
    try {
      const accepted = await this.client.remember(text, { dedupe: true });
      entry.jobId = accepted.job_id;
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      this.onChange(entry);
      return entry;
    }
    this.track(entry);
    this.onChange(entry);
    return entry;
  }

  /** Resume tracking of a pending job (e.g. after a server restart). */
  track(entry: MemoryLogEntry) {
    if (!entry.jobId || entry.status !== "pending" || this.inflight.has(entry.id)) return;
    const p = (async () => {
      try {
        const done = await this.client.waitForRememberJob(entry.jobId!, { timeoutMs: 180_000 });
        entry.blobId = done.blob_id;
        entry.status = "stored";
        entry.storedAt = new Date().toISOString();
        bump("memoryStored");
      } catch (err) {
        entry.status = "failed";
        entry.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.inflight.delete(entry.id);
        this.onChange(entry);
      }
    })();
    this.inflight.set(entry.id, p);
  }

  pendingCount() {
    return this.inflight.size;
  }

  /** Waits (bounded) for in-flight writes so the next recall can see them. */
  async settle(timeoutMs = 60_000): Promise<boolean> {
    if (!this.inflight.size) return true;
    const all = Promise.all([...this.inflight.values()]).then(() => true);
    return Promise.race([all, sleep(timeoutMs).then(() => false)]);
  }

  async recall(query: string, opts: { topK?: number; maxDistance?: number; sort?: "recent" } = {}): Promise<Memory[]> {
    bump("memoryRecalls");
    const maxDistance = opts.maxDistance ?? (this.backend === "mock" ? 0.99 : Number(process.env.MEMWAL_MAX_DISTANCE ?? 0.8));
    const res = await this.client.recall({
      query,
      topK: opts.topK ?? 20,
      maxDistance,
      ...(opts.sort ? { sort: opts.sort } : {}),
    });
    return res.results.map((r) => toMemory(r)).filter((m): m is Memory => m !== null);
  }

  /**
   * The relayer's own inventory for this namespace (metadata only, no decryption).
   * This is what Walrus actually holds, independent of the app's local write log.
   */
  async inventory(maxPages = 10): Promise<{ blobId: string; size: number; createdAt: string; endEpoch: number | null; status: string }[] | null> {
    if (!(this.client instanceof MemWal)) return null;
    const out: { blobId: string; size: number; createdAt: string; endEpoch: number | null; status: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.client.listMemories({ namespace: this.namespace, limit: 500, cursor });
      for (const m of res.memories) {
        if (m.namespace_id !== this.namespace) continue;
        out.push({ blobId: m.blob_id, size: m.size, createdAt: m.created_at, endEpoch: m.end_epoch, status: m.status });
      }
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const h = await this.client.health();
      return { ok: true, detail: JSON.stringify(h).slice(0, 160) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async publicKey(): Promise<string | null> {
    if (this.client instanceof MemWal) {
      try {
        return await this.client.getPublicKeyHex();
      } catch {
        return null;
      }
    }
    return null;
  }
}
