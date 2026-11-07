import type { SoundingPoint } from "./render";

/**
 * Real Cetus CLMM history from the live rehearsal on 2026-11-07: Tatum gRPC reads, Walrus Mainnet
 * memories, Claude verdicts. "without" is Claude re-run with zero memories.
 */
export const CETUS_REHEARSAL: SoundingPoint[] = [
  { version: 9, withMem: null, without: null, base: true },
  { version: 10, withMem: "critical", without: "high", score: 13, scoreWithout: 9, label: "expected", moved: 1 },
  { version: 11, withMem: "low", without: "low", score: 0.6, scoreWithout: 1.5, label: "suspicious", moved: 0 },
  { version: 12, withMem: "critical", without: "high", score: 12.5, scoreWithout: 9.5, label: "expected", moved: 2 },
  { version: 13, withMem: "low", without: "high", score: 2, scoreWithout: 4.5, label: "false-positive", moved: 2 },
  { version: 14, withMem: "low", without: "high", score: 1.9, scoreWithout: 6, label: "expected", moved: 2 },
  { version: 15, withMem: "low", without: "medium", score: 0.8, scoreWithout: 2.5, moved: 2 },
];
