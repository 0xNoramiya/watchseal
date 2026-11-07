import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CapState, ChainReader, PackageSnapshot, PackageVersion, UpgradeTx } from "./types";

export interface FixtureFile {
  slug: string;
  name: string;
  originalId: string;
  recordedAt: string;
  versions: PackageVersion[];
  snapshots: Record<string, PackageSnapshot>;
  txs: Record<string, UpgradeTx | null>;
  caps: Record<string, CapState>;
}

/** Offline reader over recorded Mainnet history (fixtures/*.json). */
export class FixtureReader implements ChainReader {
  readonly kind = "fixture" as const;
  private files: FixtureFile[] = [];

  constructor(dir = path.join(process.cwd(), "fixtures")) {
    if (!existsSync(/*turbopackIgnore: true*/ dir)) return;
    for (const f of readdirSync(/*turbopackIgnore: true*/ dir)) {
      if (f.endsWith(".json")) this.files.push(JSON.parse(readFileSync(path.join(/*turbopackIgnore: true*/ dir, f), "utf8")));
    }
  }

  private fileFor(packageId: string): FixtureFile {
    const f = this.files.find((x) => x.originalId === packageId || x.versions.some((v) => v.packageId === packageId));
    if (!f) throw new Error(`no fixture for package ${packageId}`);
    return f;
  }

  async listVersions(packageId: string): Promise<PackageVersion[]> {
    return this.fileFor(packageId).versions;
  }

  async getSnapshot(packageId: string): Promise<PackageSnapshot> {
    const snap = this.fileFor(packageId).snapshots[packageId];
    if (!snap) throw new Error(`fixture has no snapshot for ${packageId}`);
    return { ...snap, source: "fixture" };
  }

  async getUpgradeTx(packageId: string): Promise<UpgradeTx | null> {
    const tx = this.fileFor(packageId).txs[packageId];
    return tx ? { ...tx, source: "fixture" } : null;
  }

  async getCapState(capId: string): Promise<CapState> {
    for (const f of this.files) {
      if (f.caps[capId]) return { ...f.caps[capId], source: "fixture" };
    }
    return {
      capId,
      exists: false,
      ownerKind: "unknown",
      owner: null,
      policy: null,
      version: null,
      packageId: null,
      source: "fixture",
    };
  }
}
