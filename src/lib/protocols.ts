export interface KnownProtocol {
  slug: string;
  name: string;
  originalId: string;
  capId?: string;
  /** Suggested replay start version for the demo. */
  replayFrom?: number;
}

export const KNOWN_PROTOCOLS: KnownProtocol[] = [
  {
    slug: "cetus-clmm",
    name: "Cetus CLMM",
    originalId: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
    capId: "0x4462a572640227717cb8c60b6dd337f022743de6bc13f1fe0b7adb182d1fa274",
    replayFrom: 9,
  },
  {
    slug: "deepbook",
    name: "DeepBook V3",
    originalId: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809",
    replayFrom: 5,
  },
];

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}
