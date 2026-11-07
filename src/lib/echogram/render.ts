/**
 * Echogram: WatchSeal's upgrade history drawn in the visual language of an echo-sounder
 * paper recording (mode "echogram") or a hydrographic survey sheet (mode "survey").
 *
 * Pure: the SVG is a function of (config, points) only. All randomness comes from a
 * mulberry32 PRNG seeded with config.seed, so a saved config reproduces the exact image.
 *
 * Rules (fixed, from research into paper echo sounders and nautical charts):
 *  1. One ink on one paper tone, at most 5 grey steps between them.
 *  2. Time runs along the paper, depth (= risk) runs down it; every mark is a vertical ping column.
 *  3. A solid transmission band runs along the top edge.
 *  4. The verdict with memory is the bottom echo: darkest, sharpest at its top edge, fading only downward.
 *  5. The verdict without memory is a second echo: fainter and wider, never darker, only where it differs.
 *  6. Memories that moved a verdict are the only targets in the water column, drawn as fish arches.
 *  7. Scale lines are thin, evenly spaced, lighter than the trace, labelled in italics.
 *  8. Every version boundary is a fix mark with a hand-written label; the record stops where the replay stops.
 * Survey sheet: safe water is bare paper, hazards get at most 3 tints, figures are italic (with memory)
 * or upright (without), each contour has its own dash pattern, magenta only marks danger.
 */

export type Risk = "low" | "medium" | "high" | "critical";
const LEVELS: Risk[] = ["low", "medium", "high", "critical"];

export interface SoundingPoint {
  version: number;
  /** Verdict with memory; null when the version has not been analyzed yet. */
  withMem: Risk | null;
  /** Verdict without memory (compare result, or the memory-free estimate). */
  without: Risk | null;
  score?: number | null;
  scoreWithout?: number | null;
  label?: "expected" | "suspicious" | "false-positive" | null;
  /** How many memories moved this verdict. */
  moved?: number;
  base?: boolean;
  current?: boolean;
}

export interface EchogramConfig {
  mode: "echogram" | "survey";
  seed: number;
  height: number;
  palette: "ice" | "dry" | "wet";
  columnWidth: number;
  transmission: number;
  band: number;
  fade: number;
  gain: number;
  secondEcho: number;
  slope: number;
  roughness: number;
  whiteLine: boolean;
  archSize: number;
  handJitter: number;
  tint: number;
  figureSize: number;
  figures: number;
  contour: number;
  ticks: number;
}

export const DEFAULT_CONFIG: EchogramConfig = {
  mode: "echogram",
  seed: 20251014,
  height: 170,
  palette: "ice",
  columnWidth: 2,
  transmission: 5,
  band: 14,
  fade: 0.6,
  gain: 0.4,
  secondEcho: 0.5,
  slope: 0.18,
  roughness: 0.45,
  whiteLine: false,
  archSize: 1,
  handJitter: 0.5,
  tint: 0.6,
  figureSize: 12,
  figures: 3,
  contour: 1,
  ticks: 12,
};

type NumKey = { [K in keyof EchogramConfig]: EchogramConfig[K] extends number ? K : never }[keyof EchogramConfig];

/** Panel spec: every knob with tested bounds. */
export const KNOBS: { key: NumKey; label: string; min: number; max: number; step: number; modes: EchogramConfig["mode"][] }[] = [
  { key: "height", label: "Paper height", min: 150, max: 300, step: 10, modes: ["echogram", "survey"] },
  { key: "columnWidth", label: "Ping column width", min: 1, max: 4, step: 0.5, modes: ["echogram"] },
  { key: "transmission", label: "Transmission band", min: 2, max: 10, step: 1, modes: ["echogram"] },
  { key: "band", label: "Bottom band", min: 6, max: 28, step: 1, modes: ["echogram"] },
  { key: "fade", label: "Band fade", min: 0, max: 1, step: 0.05, modes: ["echogram"] },
  { key: "gain", label: "Gain (speckle)", min: 0, max: 1, step: 0.05, modes: ["echogram"] },
  { key: "secondEcho", label: "Second echo", min: 0.15, max: 1, step: 0.05, modes: ["echogram"] },
  { key: "slope", label: "Slope between versions", min: 0, max: 0.5, step: 0.02, modes: ["echogram"] },
  { key: "roughness", label: "Bottom roughness", min: 0, max: 1, step: 0.05, modes: ["echogram", "survey"] },
  { key: "archSize", label: "Fish arch size", min: 0.5, max: 1.6, step: 0.05, modes: ["echogram"] },
  { key: "handJitter", label: "Hand jitter", min: 0, max: 1, step: 0.05, modes: ["echogram", "survey"] },
  { key: "tint", label: "Hazard tint", min: 0.2, max: 1, step: 0.05, modes: ["survey"] },
  { key: "figureSize", label: "Figure size", min: 9, max: 16, step: 0.5, modes: ["survey"] },
  { key: "figures", label: "Soundings per version", min: 1, max: 5, step: 1, modes: ["survey"] },
  { key: "contour", label: "Contour weight", min: 0.5, max: 2, step: 0.1, modes: ["survey"] },
  { key: "ticks", label: "Border ticks", min: 4, max: 24, step: 1, modes: ["survey"] },
];

const PALETTES: Record<EchogramConfig["palette"], { paper: string; ink: string }> = {
  ice: { paper: "#EEF3F5", ink: "#0F2A36" },
  dry: { paper: "#E9E7E1", ink: "#1B1C1C" },
  wet: { paper: "#EFE4CC", ink: "#5A3519" },
};
const CHART_BLUE = "#2C6FD1";
const MAGENTA = "#B0287A";

export const WIDTH = 960;
export const LEFT = 58;
const RIGHT = 10;
const TOP = 8;
const BOTTOM_PAD = 28;

export interface EchogramLayout {
  width: number;
  height: number;
  left: number;
  plotW: number;
  segW: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const smooth = (t: number) => t * t * (3 - 2 * t);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** 1D value noise from the seeded PRNG. */
function makeNoise(rand: () => number, n = 64) {
  const lattice = Array.from({ length: n + 1 }, rand);
  return (x: number) => {
    const xi = Math.floor(x) % n;
    const xf = x - Math.floor(x);
    const i = (xi + n) % n;
    return lattice[i] + (lattice[i + 1] - lattice[i]) * smooth(xf);
  };
}

const SHORT_LABEL = { expected: "exp.", suspicious: "susp.", "false-positive": "f.p." } as const;

/** `width` is the viewBox width; pass roughly the on-screen width so text renders at its real size. */
export function renderEchogram(cfg: EchogramConfig, points: SoundingPoint[], width = WIDTH): { svg: string; layout: EchogramLayout } {
  const rand = mulberry32(cfg.seed);
  const noise = makeNoise(rand);
  const { paper, ink } = PALETTES[cfg.palette] ?? PALETTES.ice;
  const steps = [0.12, 0.28, 0.48, 0.72, 0.95].map((t) => mix(paper, ink, t));
  const H = cfg.height;
  const n = Math.max(1, points.length);
  const plotW = width - LEFT - RIGHT;
  const segW = plotW / n;
  const layout = { width, height: H, left: LEFT, plotW, segW };
  const out: string[] = [];
  out.push(`<rect width="${width}" height="${H}" fill="${paper}"/>`);

  const recorded = points.reduce((last, p, i) => (p.withMem || p.base ? i : last), -1);
  const recordEnd = LEFT + segW * (recorded + 1);
  const hand = (x: number, y: number, text: string, size: number, fill: string, extra = "") => {
    const rot = (rand() - 0.5) * 8 * cfg.handJitter;
    const dy = (rand() - 0.5) * 3 * cfg.handJitter;
    return `<text x="${r1(x)}" y="${r1(y + dy)}" transform="rotate(${r1(rot)} ${r1(x)} ${r1(y)})" style="font-family:var(--font-hand),'Caveat',cursive;font-size:${size}px" fill="${fill}"${extra}>${esc(text)}</text>`;
  };

  if (cfg.mode === "survey") {
    renderSurvey(out, cfg, points, { rand, ink, paper, H, segW, recorded, hand, width });
    return { svg: wrap(out, width, H), layout };
  }

  // ---------------- echogram ----------------
  const waterTop = TOP + cfg.transmission;
  const floor = H - BOTTOM_PAD;
  const D = floor - waterTop;
  const depthOf = (r: Risk | null) => waterTop + D * [0.2, 0.42, 0.64, 0.86][LEVELS.indexOf(r ?? "low")];
  const baseDepth = (p: SoundingPoint) => depthOf(p.withMem ?? (p.base ? "low" : null));

  // scale lines and italic level labels (drawn by the stylus, so only on recorded paper)
  [0.31, 0.53, 0.75].forEach((f) => {
    const y = r1(waterTop + D * f);
    out.push(`<line x1="${LEFT}" x2="${r1(recordEnd)}" y1="${y}" y2="${y}" stroke="${steps[1]}" stroke-width="0.6"/>`);
  });
  LEVELS.forEach((l) => {
    out.push(
      `<text x="${LEFT - 8}" y="${r1(depthOf(l) + 4)}" text-anchor="end" font-style="italic" font-size="10.5" fill="${steps[3]}" style="font-family:var(--font-sans),sans-serif">${l}</text>`,
    );
  });

  // transmission band
  if (recorded >= 0) out.push(`<rect x="${LEFT}" y="${TOP}" width="${r1(recordEnd - LEFT)}" height="${cfg.transmission}" fill="${steps[4]}"/>`);

  const cw = cfg.columnWidth;
  const depthAt = (x: number, pick: (p: SoundingPoint) => number | null) => {
    const vi = Math.min(n - 1, Math.floor((x - LEFT) / segW));
    const t = (x - LEFT - vi * segW) / segW;
    const cur = pick(points[vi]);
    if (cur === null) return null;
    let d = cur;
    if (cfg.slope > 0 && vi > 0 && t < cfg.slope) {
      const prev = pick(points[vi - 1]);
      if (prev !== null) d = prev + (cur - prev) * smooth(t / cfg.slope);
    }
    return d + (noise(x * 0.045) - 0.5) * 10 * cfg.roughness;
  };

  for (let x = LEFT; x < recordEnd; x += cw) {
    const w = r1(cw + 0.15);
    // speckle in the water column, denser near the bottom and with more gain
    const d = depthAt(x, baseDepth);
    if (d === null) continue;
    const dots = Math.floor(rand() * 3.2 * cfg.gain);
    for (let k = 0; k < dots; k++) {
      const yy = waterTop + 3 + Math.pow(rand(), 0.6) * (d - waterTop - 4);
      out.push(`<rect x="${r1(x)}" y="${r1(yy)}" width="${w}" height="1.2" fill="${steps[rand() < 0.7 ? 0 : 1]}"/>`);
    }
    // second echo: the verdict without memory, only where it differs
    const ghost = depthAt(x, (p) => (p.without && p.withMem && p.without !== p.withMem ? depthOf(p.without) : null));
    if (ghost !== null && rand() < 0.45 + cfg.secondEcho * 0.55) {
      const gh = cfg.band * 1.7;
      out.push(`<rect x="${r1(x)}" y="${r1(ghost)}" width="${w}" height="${r1(gh * 0.45)}" fill="${steps[cfg.secondEcho > 0.6 ? 2 : 1]}"/>`);
      out.push(`<rect x="${r1(x)}" y="${r1(ghost + gh * 0.45)}" width="${w}" height="${r1(gh * 0.55)}" fill="${steps[0]}"/>`);
    }
    // bottom echo: sharp dark top edge, fading only downward
    const top = r1(d);
    const solid = cfg.band * (1 - cfg.fade);
    const fadeH = (cfg.band * cfg.fade) / 3;
    const maxY = H - BOTTOM_PAD + 6;
    let y = d;
    if (cfg.whiteLine) {
      out.push(`<rect x="${r1(x)}" y="${top}" width="${w}" height="1.4" fill="${steps[4]}"/>`);
      y += 2.6;
    }
    out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${w}" height="${r1(Math.max(1.4, Math.min(solid, maxY - y)))}" fill="${steps[4]}"/>`);
    y += solid;
    for (let j = 3; j >= 1 && y < maxY; j--) {
      out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${w}" height="${r1(Math.min(fadeH, maxY - y))}" fill="${steps[j]}"/>`);
      y += fadeH;
    }
    // speckle under the band
    if (rand() < cfg.gain * 0.6) out.push(`<rect x="${r1(x)}" y="${r1(Math.min(maxY, y + rand() * 8))}" width="${w}" height="1.2" fill="${steps[1]}"/>`);
  }

  // fish arches: memories that moved the verdict
  points.forEach((p, i) => {
    if (!p.withMem || !p.moved) return;
    const d = depthOf(p.withMem);
    for (let k = 0; k < Math.min(4, p.moved); k++) {
      const cx = LEFT + i * segW + segW * (0.25 + 0.5 * rand());
      const span = 16 * cfg.archSize;
      const droop = 7 * cfg.archSize;
      const yTop = waterTop + 6 + rand() * Math.max(4, d - waterTop - droop - 18);
      for (let dx = -span / 2; dx <= span / 2; dx += cw) {
        const yy = yTop + droop * Math.pow((2 * dx) / span, 2);
        out.push(`<rect x="${r1(cx + dx)}" y="${r1(yy)}" width="${r1(cw + 0.15)}" height="2.2" fill="${steps[3]}"/>`);
      }
    }
  });

  // fix marks and hand-written labels
  points.forEach((p, i) => {
    const x = LEFT + i * segW;
    const recordedHere = i <= recorded;
    if (recordedHere) out.push(`<line x1="${r1(x)}" x2="${r1(x)}" y1="${TOP}" y2="${H - BOTTOM_PAD + 8}" stroke="${steps[2]}" stroke-width="0.8"/>`);
    const text = `v${p.version}${p.base ? " base" : p.label ? ` ${SHORT_LABEL[p.label]}` : ""}`;
    out.push(hand(x + 4, H - 9, text, 15, recordedHere ? steps[4] : steps[1]));
    if (p.current) {
      const ux = x + 4;
      const len = 8 * text.length * 0.62;
      const wob = (rand() - 0.5) * 2 * cfg.handJitter;
      out.push(`<path d="M${r1(ux)} ${r1(H - 4)} q${r1(len / 2)} ${r1(1.6 + wob)} ${r1(len)} ${r1(-0.6 + wob)}" fill="none" stroke="${steps[4]}" stroke-width="1.4" stroke-linecap="round"/>`);
    }
  });
  return { svg: wrap(out, width, H), layout };
}

function wrap(out: string[], W: number, H: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-hidden="true" style="display:block;width:100%;height:auto">${out.join("")}</svg>`;
}

// ---------------- survey sheet ----------------

function renderSurvey(
  out: string[],
  cfg: EchogramConfig,
  points: SoundingPoint[],
  ctx: { rand: () => number; ink: string; paper: string; H: number; segW: number; recorded: number; width: number; hand: (x: number, y: number, t: string, s: number, f: string) => string },
) {
  const { rand, ink, paper, H, segW, recorded } = ctx;
  const tints = [0.16, 0.3, 0.46].map((t) => mix(paper, CHART_BLUE, t * (0.5 + cfg.tint * 0.6)));
  const inner = { x: LEFT, y: 18, w: ctx.width - LEFT - RIGHT, h: H - 18 - BOTTOM_PAD };

  // hazard areas: bare paper for low risk, tints for medium/high/critical, each outlined by its own isobath pattern
  const dashes = ["", "10 4", "6 3 1.5 3", "1.2 2.6"]; // medium long dashes, high dash-dot, critical dots
  points.forEach((p, i) => {
    if (!p.withMem || p.withMem === "low") return;
    const lvl = LEVELS.indexOf(p.withMem);
    const cx = inner.x + segW * (i + 0.5);
    const cy = inner.y + inner.h * 0.5;
    const rx = segW * (0.22 + 0.08 * lvl);
    const ry = inner.h * (0.18 + 0.08 * lvl);
    const pts: string[] = [];
    const k = 36;
    // periodic wobble (sum of harmonics with seeded phases) so the outline closes cleanly
    const phases = [rand(), rand(), rand()].map((v) => v * Math.PI * 2);
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2;
      const wob = 1 + cfg.roughness * (0.09 * Math.sin(2 * a + phases[0]) + 0.06 * Math.sin(3 * a + phases[1]) + 0.04 * Math.sin(5 * a + phases[2]));
      pts.push(`${r1(cx + Math.cos(a) * rx * wob)},${r1(cy + Math.sin(a) * ry * wob)}`);
    }
    out.push(`<polygon points="${pts.join(" ")}" fill="${tints[lvl - 1]}" stroke="${ink}" stroke-width="${r1(0.7 * cfg.contour)}" stroke-dasharray="${dashes[lvl]}"/>`);
    if (p.withMem === "critical") {
      out.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(Math.min(rx, ry) * 0.42)}" fill="none" stroke="${MAGENTA}" stroke-width="1.2" stroke-dasharray="1.2 2.4"/>`);
    }
  });

  // soundings: italic figures with memory, upright figures without
  const figure = (x: number, y: number, score: number, italic: boolean, fill: string) => {
    const whole = Math.floor(score);
    const frac = Math.round((score - whole) * 10);
    return `<text x="${r1(x)}" y="${r1(y)}" font-size="${cfg.figureSize}" fill="${fill}" text-anchor="middle" style="font-family:var(--font-sans),sans-serif${italic ? ";font-style:italic" : ""}">${whole}${frac ? `<tspan font-size="${r1(cfg.figureSize * 0.7)}" dy="3">${frac}</tspan>` : ""}</text>`;
  };
  points.forEach((p, i) => {
    if (!p.withMem || p.score === undefined || p.score === null) return;
    const x0 = inner.x + segW * i;
    for (let k = 0; k < cfg.figures; k++) {
      const jitter = (rand() - 0.5) * 0.4;
      const fx = x0 + segW * (0.2 + (0.6 * (k + 0.5)) / cfg.figures + jitter * 0.2);
      const fy = inner.y + inner.h * (0.3 + rand() * 0.4);
      const s = Math.max(0, p.score + (k === 0 ? 0 : (rand() - 0.5) * 0.8));
      out.push(figure(fx, fy, s, true, ink));
    }
    if (p.without && p.without !== p.withMem && p.scoreWithout !== undefined && p.scoreWithout !== null) {
      out.push(figure(x0 + segW * 0.5, inner.y + inner.h * 0.9, p.scoreWithout, false, mix(paper, ink, 0.45)));
    }
  });

  // neatline with alternating border ticks, version labels along the top like a graticule
  out.push(`<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" fill="none" stroke="${ink}" stroke-width="1"/>`);
  const tickW = inner.w / (cfg.ticks * Math.max(1, points.length) / 2);
  for (let x = inner.x, k = 0; x < inner.x + inner.w; x += tickW, k++) {
    if (k % 2 === 0) {
      out.push(`<rect x="${r1(x)}" y="${inner.y - 4}" width="${r1(Math.min(tickW, inner.x + inner.w - x))}" height="4" fill="${ink}"/>`);
      out.push(`<rect x="${r1(x)}" y="${inner.y + inner.h}" width="${r1(Math.min(tickW, inner.x + inner.w - x))}" height="4" fill="${ink}"/>`);
    }
  }
  points.forEach((p, i) => {
    const x = inner.x + segW * i;
    out.push(`<line x1="${r1(x)}" x2="${r1(x)}" y1="${inner.y}" y2="${inner.y + inner.h}" stroke="${mix(paper, ink, 0.18)}" stroke-width="0.6"/>`);
    const label = `v${p.version}${p.base ? " base" : p.label ? ` ${SHORT_LABEL[p.label]}` : ""}`;
    out.push(ctx.hand(x + 4, H - 9, label, 15, i <= recorded ? ink : mix(paper, ink, 0.3)));
    if (p.current) out.push(`<rect x="${r1(x + 1)}" y="${inner.y + 1}" width="${r1(segW - 2)}" height="3" fill="${CHART_BLUE}"/>`);
  });
  out.push(
    `<text x="${inner.x}" y="12" font-size="9.5" fill="${MAGENTA}" letter-spacing="0.08em" style="font-family:var(--font-sans),sans-serif">RISK SOUNDINGS: ITALIC WITH MEMORY, UPRIGHT WITHOUT</text>`,
  );
}
