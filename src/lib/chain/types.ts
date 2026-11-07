export type DataSource = "tatum" | "archival" | "fixture";

export type Visibility = "private" | "public" | "friend";

export interface FnSig {
  name: string;
  visibility: Visibility;
  isEntry: boolean;
  typeParams: number;
  params: string[];
  returns: string[];
}

export interface StructSig {
  name: string;
  abilities: string[];
  fields: string[]; // "name: type"
  kind: "struct" | "enum";
}

export interface ModuleAbi {
  name: string;
  functions: Record<string, FnSig>;
  structs: Record<string, StructSig>;
}

export interface PackageVersion {
  packageId: string;
  version: number;
}

export interface PackageSnapshot {
  packageId: string;
  version: number;
  modules: Record<string, ModuleAbi>;
  /** sha256 of each module's bytecode, keyed by module name */
  bytecode: Record<string, string>;
  source: DataSource;
}

export type SignatureScheme =
  | "ed25519"
  | "secp256k1"
  | "secp256r1"
  | "multisig"
  | "bls"
  | "zklogin"
  | "passkey"
  | "unknown";

export interface UpgradeTx {
  digest: string;
  timestampMs: number | null;
  sender: string;
  schemes: SignatureScheme[];
  capId: string | null;
  capOwner: string | null;
  capOwnerKind: string | null;
  source: DataSource;
}

export interface CapState {
  capId: string;
  exists: boolean;
  ownerKind: "address" | "object" | "shared" | "immutable" | "consensus-address" | "unknown" | "destroyed";
  owner: string | null;
  policy: number | null;
  version: number | null;
  packageId: string | null;
  source: DataSource;
}

export interface ChainReader {
  readonly kind: "tatum" | "fixture";
  listVersions(packageId: string): Promise<PackageVersion[]>;
  getSnapshot(packageId: string, version: number): Promise<PackageSnapshot>;
  /** The transaction that published this package version (the upgrade). */
  getUpgradeTx(packageId: string): Promise<UpgradeTx | null>;
  getCapState(capId: string): Promise<CapState>;
}

export const SCHEMES: SignatureScheme[] = [
  "ed25519",
  "secp256k1",
  "secp256r1",
  "multisig",
  "bls",
  "zklogin",
  "passkey",
];

export function schemeFromCode(code: number | undefined | null): SignatureScheme {
  return code !== undefined && code !== null && SCHEMES[code] ? SCHEMES[code] : "unknown";
}

export const POLICY_NAMES: Record<number, string> = {
  0: "compatible",
  128: "additive",
  192: "dep-only",
};

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return "?";
  return a.length > 2 + n * 2 ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a;
}
