import { createHash } from "node:crypto";
import type { FnSig, ModuleAbi, StructSig, Visibility } from "./types";

// Minimal structural types for the protobuf-ts messages we read, so this file
// does not depend on deep SDK import paths.
interface PbBody {
  type?: number;
  typeName?: string;
  typeParameterInstantiation?: PbBody[];
  typeParameter?: number;
}
interface PbSig {
  reference?: number;
  body?: PbBody;
}
interface PbFn {
  name?: string;
  visibility?: number;
  isEntry?: boolean;
  typeParameters?: unknown[];
  parameters?: PbSig[];
  returns?: PbSig[];
}
interface PbDatatype {
  name?: string;
  abilities?: number[];
  kind?: number;
  fields?: { name?: string; type?: PbBody }[];
  variants?: { name?: string }[];
}
export interface PbModule {
  name?: string;
  contents?: Uint8Array;
  functions?: PbFn[];
  datatypes?: PbDatatype[];
}

const PRIMS: Record<number, string> = {
  1: "address",
  2: "bool",
  3: "u8",
  4: "u16",
  5: "u32",
  6: "u64",
  7: "u128",
  8: "u256",
};

/** Shorten "0x000…02::object::UID" style names to "0x2::object::UID". */
function shortType(t: string): string {
  return t.replace(/0x0*([0-9a-f]+)::/gi, (_m, h: string) => (h.length > 6 ? `0x${h.slice(0, 4)}::` : `0x${h}::`));
}

export function bodyToString(b: PbBody | undefined): string {
  if (!b || b.type === undefined) return "?";
  if (PRIMS[b.type]) return PRIMS[b.type];
  if (b.type === 9) return `vector<${bodyToString(b.typeParameterInstantiation?.[0])}>`;
  if (b.type === 10) {
    const args = b.typeParameterInstantiation ?? [];
    const name = shortType(b.typeName ?? "?");
    return args.length ? `${name}<${args.map(bodyToString).join(", ")}>` : name;
  }
  if (b.type === 11) return `T${b.typeParameter ?? 0}`;
  return "?";
}

function sigToString(s: PbSig): string {
  const prefix = s.reference === 1 ? "&" : s.reference === 2 ? "&mut " : "";
  return prefix + bodyToString(s.body);
}

function visibility(v: number | undefined): Visibility {
  return v === 2 ? "public" : v === 3 ? "friend" : "private";
}

const ABILITIES: Record<number, string> = { 1: "copy", 2: "drop", 3: "store", 4: "key" };

export function normalizeModule(m: PbModule): ModuleAbi {
  const functions: Record<string, FnSig> = {};
  for (const f of m.functions ?? []) {
    if (!f.name) continue;
    functions[f.name] = {
      name: f.name,
      visibility: visibility(f.visibility),
      isEntry: !!f.isEntry,
      typeParams: f.typeParameters?.length ?? 0,
      params: (f.parameters ?? []).map(sigToString),
      returns: (f.returns ?? []).map(sigToString),
    };
  }
  const structs: Record<string, StructSig> = {};
  for (const d of m.datatypes ?? []) {
    if (!d.name) continue;
    structs[d.name] = {
      name: d.name,
      abilities: (d.abilities ?? []).map((a) => ABILITIES[a] ?? `a${a}`).sort(),
      fields:
        d.kind === 2
          ? (d.variants ?? []).map((v) => `variant ${v.name}`)
          : (d.fields ?? []).map((f) => `${f.name}: ${bodyToString(f.type)}`),
      kind: d.kind === 2 ? "enum" : "struct",
    };
  }
  return { name: m.name ?? "?", functions, structs };
}

export function hashBytes(b: Uint8Array | undefined): string {
  return createHash("sha256")
    .update(b ?? new Uint8Array())
    .digest("hex");
}

/** Converts a protobuf-ts google.protobuf.Value into plain JSON. */
export function pbValueToJson(v: unknown): unknown {
  if (!v || typeof v !== "object") return v ?? null;
  const kind = (v as { kind?: { oneofKind?: string; [k: string]: unknown } }).kind;
  if (!kind || !kind.oneofKind) return null;
  const inner = kind[kind.oneofKind];
  switch (kind.oneofKind) {
    case "nullValue":
      return null;
    case "numberValue":
    case "stringValue":
    case "boolValue":
      return inner;
    case "structValue": {
      const fields = (inner as { fields?: Record<string, unknown> })?.fields ?? {};
      return Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, pbValueToJson(x)]));
    }
    case "listValue":
      return ((inner as { values?: unknown[] })?.values ?? []).map(pbValueToJson);
    default:
      return null;
  }
}
