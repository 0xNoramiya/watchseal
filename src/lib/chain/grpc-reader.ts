import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { bump } from "../metrics";
import { fetchArchivalTx } from "./archival";
import { hashBytes, normalizeModule, pbValueToJson } from "./normalize";
import { createTatumClient } from "./tatum";
import { isNotFound, tatumCall } from "./throttle";
import {
  schemeFromCode,
  type CapState,
  type ChainReader,
  type ModuleAbi,
  type PackageSnapshot,
  type PackageVersion,
  type UpgradeTx,
} from "./types";

const OWNER_KINDS: Record<number, CapState["ownerKind"]> = {
  1: "address",
  2: "object",
  3: "shared",
  4: "immutable",
  5: "consensus-address",
};

/** Live chain reader: every read goes through Tatum's Sui gRPC gateway, with archival GraphQL for pruned txs. */
export class TatumGrpcReader implements ChainReader {
  readonly kind = "tatum" as const;
  private client: SuiGrpcClient;
  private versionCache = new Map<string, PackageVersion[]>();
  private snapshotCache = new Map<string, PackageSnapshot>();
  private txCache = new Map<string, UpgradeTx | null>();

  constructor(client?: SuiGrpcClient) {
    this.client = client ?? createTatumClient();
  }

  private call<T>(fn: () => PromiseLike<T>): Promise<T> {
    bump("tatumCalls");
    return tatumCall(fn);
  }

  async listVersions(packageId: string): Promise<PackageVersion[]> {
    const out: PackageVersion[] = [];
    let pageToken: Uint8Array | undefined;
    do {
      const { response } = await this.call(() =>
        this.client.movePackageService.listPackageVersions({ packageId, pageSize: 100, pageToken }),
      );
      for (const v of response.versions) out.push({ packageId: v.packageId!, version: Number(v.version) });
      pageToken = response.nextPageToken?.length ? response.nextPageToken : undefined;
    } while (pageToken);
    out.sort((a, b) => a.version - b.version);
    for (const v of out) this.versionCache.set(v.packageId, out);
    return out;
  }

  async getSnapshot(packageId: string, version: number): Promise<PackageSnapshot> {
    const cached = this.snapshotCache.get(packageId);
    if (cached) return cached;
    const { response: pkg } = await this.call(() => this.client.movePackageService.getPackage({ packageId }));
    const modules: Record<string, ModuleAbi> = {};
    for (const m of pkg.package?.modules ?? []) {
      const abi = normalizeModule(m);
      modules[abi.name] = abi;
    }
    const { response: obj } = await this.call(() =>
      this.client.ledgerService.getObject({
        objectId: packageId,
        readMask: { paths: ["package.modules.name", "package.modules.contents"] },
      }),
    );
    const bytecode: Record<string, string> = {};
    for (const m of obj.object?.package?.modules ?? []) {
      if (m.name) bytecode[m.name] = hashBytes(m.contents);
    }
    const snap: PackageSnapshot = {
      packageId,
      version: Number(pkg.package?.version ?? version),
      modules,
      bytecode,
      source: "tatum",
    };
    this.snapshotCache.set(packageId, snap);
    return snap;
  }

  async getUpgradeTx(packageId: string): Promise<UpgradeTx | null> {
    if (this.txCache.has(packageId)) return this.txCache.get(packageId)!;
    const { response: obj } = await this.call(() =>
      this.client.ledgerService.getObject({ objectId: packageId, readMask: { paths: ["previous_transaction"] } }),
    );
    const digest = obj.object?.previousTransaction;
    if (!digest) return null;

    let tx: UpgradeTx | null = null;
    try {
      const { response } = await this.call(() =>
        this.client.ledgerService.getTransaction({
          digest,
          readMask: { paths: ["digest", "timestamp", "transaction.sender", "signatures", "effects.changed_objects"] },
        }),
      );
      const t = response.transaction;
      const cap = t?.effects?.changedObjects.find((o) => o.objectType?.endsWith("::package::UpgradeCap"));
      const ts = t?.timestamp;
      tx = {
        digest,
        timestampMs: ts ? Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6) : null,
        sender: t?.transaction?.sender ?? "?",
        schemes: (t?.signatures ?? []).map((s) => schemeFromCode(s.scheme)),
        capId: cap?.objectId ?? null,
        capOwner: cap?.outputOwner?.address ?? null,
        capOwnerKind: cap?.outputOwner?.kind ? (OWNER_KINDS[cap.outputOwner.kind] ?? "unknown") : null,
        source: "tatum",
      };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      tx = await fetchArchivalTx(digest);
    }
    this.txCache.set(packageId, tx);
    return tx;
  }

  async getCapState(capId: string): Promise<CapState> {
    try {
      const { response } = await this.call(() =>
        this.client.ledgerService.getObject({
          objectId: capId,
          readMask: { paths: ["owner", "json", "object_type", "version"] },
        }),
      );
      const o = response.object;
      const json = (pbValueToJson(o?.json) ?? {}) as Record<string, unknown>;
      return {
        capId,
        exists: true,
        ownerKind: o?.owner?.kind ? (OWNER_KINDS[o.owner.kind] ?? "unknown") : "unknown",
        owner: o?.owner?.address ?? null,
        policy: json.policy !== undefined ? Number(json.policy) : null,
        version: json.version !== undefined ? Number(json.version) : null,
        packageId: typeof json.package === "string" ? json.package : null,
        source: "tatum",
      };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return {
        capId,
        exists: false,
        ownerKind: "destroyed",
        owner: null,
        policy: null,
        version: null,
        packageId: null,
        source: "tatum",
      };
    }
  }
}
