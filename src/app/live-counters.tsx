"use client";

import { useEffect, useState } from "react";
import type { Counters } from "@/lib/metrics";

interface Snapshot {
  counters: Counters;
  memories: number;
  protocols: number;
  backend: "walrus" | "mock";
}

/** Ticks a number up from 0 once it arrives, so it reads as live. Instant under reduced motion. */
function CountUp({ value }: { value: number | undefined }) {
  const [shown, setShown] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (value === undefined) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || value === 0) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const dur = 700;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown ?? "–"}</>;
}

/** Live numbers from this WatchSeal instance (the same state the dashboard uses). */
export default function LiveCounters() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/state", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setSnap({
          counters: d.counters,
          memories: d.memoryLog.filter((m: { status: string }) => m.status === "stored").length,
          protocols: d.watchlist.length,
          backend: d.memoryBackend,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const items: [string, number | undefined][] = [
    [snap?.backend === "mock" ? "memories (offline mock)" : "memories on Walrus Mainnet", snap?.memories],
    ["Tatum gRPC calls", snap?.counters.tatumCalls],
    ["archival reads", snap?.counters.archivalCalls],
    ["protocols watched", snap?.protocols],
  ];
  return (
    <dl className="l-live" aria-live="polite">
      {items.map(([k, v]) => (
        <div key={k}>
          <dd>
            <CountUp value={v} />
          </dd>
          <dt>{k}</dt>
        </div>
      ))}
    </dl>
  );
}
