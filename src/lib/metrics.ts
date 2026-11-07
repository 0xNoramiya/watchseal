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

const g = globalThis as unknown as { __watchsealCounters?: Counters };

export const counters: Counters = (g.__watchsealCounters ??= {
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
    if (typeof saved[k] === "number" && saved[k]! > counters[k]) counters[k] = saved[k]!;
  }
}
