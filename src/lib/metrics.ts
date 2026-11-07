export interface Counters {
  tatumCalls: number;
  archivalCalls: number;
  memoryWrites: number;
  memoryStored: number;
  memoryRecalls: number;
  claudeCalls: number;
  fallbackVerdicts: number;
  alerts: number;
}

// Kept on globalThis so dev-server hot reloads keep counting from where they were.
declare global {
  var __watchsealCounters: Counters | undefined;
}

export const counters: Counters = (globalThis.__watchsealCounters ??= {
  tatumCalls: 0,
  archivalCalls: 0,
  memoryWrites: 0,
  memoryStored: 0,
  memoryRecalls: 0,
  claudeCalls: 0,
  fallbackVerdicts: 0,
  alerts: 0,
});

export function bump(key: keyof Counters, n = 1) {
  counters[key] += n;
}

export function loadCounters(saved: Partial<Counters> | undefined) {
  if (!saved) return;
  for (const k of Object.keys(counters) as (keyof Counters)[]) {
    const v = saved[k];
    if (typeof v === "number" && v > counters[k]) counters[k] = v;
  }
}
