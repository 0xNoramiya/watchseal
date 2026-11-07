import type { FnSig, ModuleAbi, PackageSnapshot, StructSig } from "../chain/types";

export interface FnRef {
  module: string;
  fn: FnSig;
}

export interface FnChange {
  module: string;
  name: string;
  before: FnSig;
  after: FnSig;
  visibilityWidened: boolean;
  entryAdded: boolean;
}

export interface StructChange {
  module: string;
  name: string;
  before: StructSig;
  after: StructSig;
}

export interface AbiDiff {
  fromVersion: number;
  toVersion: number;
  addedModules: string[];
  removedModules: string[];
  /** Externally reachable functions (public, friend or entry) that are new. */
  addedFunctions: FnRef[];
  addedPrivateCount: number;
  removedFunctions: { module: string; name: string; visibility: string }[];
  changedFunctions: FnChange[];
  addedStructs: { module: string; s: StructSig }[];
  changedStructs: StructChange[];
  /** Modules whose bytecode hash changed. */
  bytecodeChanged: string[];
  /** Modules whose bytecode changed while their external ABI did not. */
  bytecodeOnly: string[];
}

const VIS_RANK = { private: 0, friend: 1, public: 2 } as const;

function reachable(f: FnSig): boolean {
  return f.visibility !== "private" || f.isEntry;
}

function surfaceKey(m: ModuleAbi | undefined): string {
  if (!m) return "";
  const fns = Object.values(m.functions)
    .filter(reachable)
    .map((f) => `${f.name}|${f.visibility}|${f.isEntry}|${f.typeParams}|${f.params.join(",")}|${f.returns.join(",")}`)
    .sort();
  const structs = Object.values(m.structs)
    .map((s) => `${s.name}|${s.abilities.join(",")}|${s.fields.join(",")}`)
    .sort();
  return fns.join("\n") + "\n--\n" + structs.join("\n");
}

export function diffPackages(prev: PackageSnapshot, next: PackageSnapshot): AbiDiff {
  const d: AbiDiff = {
    fromVersion: prev.version,
    toVersion: next.version,
    addedModules: [],
    removedModules: [],
    addedFunctions: [],
    addedPrivateCount: 0,
    removedFunctions: [],
    changedFunctions: [],
    addedStructs: [],
    changedStructs: [],
    bytecodeChanged: [],
    bytecodeOnly: [],
  };

  const names = new Set([...Object.keys(prev.modules), ...Object.keys(next.modules)]);
  for (const name of [...names].sort()) {
    const a = prev.modules[name];
    const b = next.modules[name];
    if (!a && b) d.addedModules.push(name);
    if (a && !b) d.removedModules.push(name);

    const af = a?.functions ?? {};
    const bf = b?.functions ?? {};
    for (const [fname, fn] of Object.entries(bf)) {
      const old = af[fname];
      if (!old) {
        if (reachable(fn)) d.addedFunctions.push({ module: name, fn });
        else d.addedPrivateCount++;
        continue;
      }
      const visibilityWidened = VIS_RANK[fn.visibility] > VIS_RANK[old.visibility];
      const entryAdded = fn.isEntry && !old.isEntry;
      const sigChanged =
        old.params.join(",") !== fn.params.join(",") ||
        old.returns.join(",") !== fn.returns.join(",") ||
        old.typeParams !== fn.typeParams;
      if (visibilityWidened || entryAdded || (sigChanged && reachable(fn))) {
        d.changedFunctions.push({ module: name, name: fname, before: old, after: fn, visibilityWidened, entryAdded });
      }
    }
    for (const [fname, fn] of Object.entries(af)) {
      if (!bf[fname] && reachable(fn)) d.removedFunctions.push({ module: name, name: fname, visibility: fn.visibility });
    }

    const as = a?.structs ?? {};
    const bs = b?.structs ?? {};
    for (const [sname, s] of Object.entries(bs)) {
      const old = as[sname];
      if (!old) d.addedStructs.push({ module: name, s });
      else if (old.abilities.join(",") !== s.abilities.join(",") || old.fields.join(",") !== s.fields.join(",")) {
        d.changedStructs.push({ module: name, name: sname, before: old, after: s });
      }
    }

    if (a && b && prev.bytecode[name] && next.bytecode[name] && prev.bytecode[name] !== next.bytecode[name]) {
      d.bytecodeChanged.push(name);
      if (surfaceKey(a) === surfaceKey(b)) d.bytecodeOnly.push(name);
    }
  }
  return d;
}

export function diffSummary(d: AbiDiff): string {
  const parts: string[] = [];
  if (d.addedModules.length) parts.push(`new modules: ${d.addedModules.join(", ")}`);
  if (d.removedModules.length) parts.push(`removed modules: ${d.removedModules.join(", ")}`);
  if (d.addedFunctions.length) parts.push(`${d.addedFunctions.length} new public/entry fns`);
  if (d.changedFunctions.length) parts.push(`${d.changedFunctions.length} changed fns`);
  if (d.addedStructs.length) parts.push(`${d.addedStructs.length} new types`);
  if (d.bytecodeOnly.length) parts.push(`bytecode-only changes in ${d.bytecodeOnly.length} modules`);
  return parts.join("; ") || "no ABI or bytecode change";
}
