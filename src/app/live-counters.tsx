"use client";

import { useEffect, useState } from "react";
import type { Counters } from "@/lib/metrics";

interface Snapshot {
  counters: Counters;
  memories: number;
  protocols: number;
  backend: "walrus" | "mock";
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
          <dd>{v ?? "–"}</dd>
          <dt>{k}</dt>
        </div>
      ))}
    </dl>
  );
}
