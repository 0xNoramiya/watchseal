/**
 * Underwater UI sounds, generated once with ElevenLabs (scripts/generate-sfx.ts) and served from
 * public/sfx. Client-only. Quiet by default, mutable, remembered per browser.
 */
import { useSyncExternalStore } from "react";

export type Sfx = "blub" | "blublub" | "sonar" | "surface";

const KEY = "watchseal-sound";
const VOLUME: Record<Sfx, number> = { blub: 0.32, blublub: 0.3, sonar: 0.34, surface: 0.3 };
const listeners = new Set<() => void>();
const cache = new Map<Sfx, HTMLAudioElement>();
const lastPlayed = new Map<Sfx, number>();
let enabled: boolean | null = null;

function readEnabled(): boolean {
  if (enabled !== null) return enabled;
  try {
    enabled = localStorage.getItem(KEY) !== "off";
  } catch {
    enabled = true; // storage unavailable: sound stays on for this page view
  }
  return enabled;
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // not persisted, still applies to this page view
  }
  listeners.forEach((l) => l());
  if (on) playSfx("blub");
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readEnabled,
    () => true,
  );
}

function base(name: Sfx): HTMLAudioElement {
  let a = cache.get(name);
  if (!a) {
    a = new Audio(`/sfx/${name}.mp3`);
    a.preload = "auto";
    cache.set(name, a);
  }
  return a;
}

export function preloadSfx() {
  if (typeof window === "undefined") return;
  (["blub", "blublub", "sonar", "surface"] as Sfx[]).forEach(base);
}

/** Plays a sound unless muted. Repeats of the same sound within 80ms are dropped. */
export function playSfx(name: Sfx) {
  if (typeof window === "undefined" || !readEnabled()) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -1e9) < 80) return;
  lastPlayed.set(name, now);
  const a = base(name).cloneNode(true) as HTMLAudioElement;
  a.volume = VOLUME[name];
  // Browsers block audio until the user has interacted with the page; that is fine to ignore.
  a.play().catch(() => {});
}
