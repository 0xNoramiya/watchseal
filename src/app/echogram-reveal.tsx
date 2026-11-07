"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Plays the echogram like a recorder: a stylus sweeps left to right when the figure scrolls into
 * view. Progressive enhancement: without JS, or with reduced motion, the figure is simply shown.
 */
export default function EchogramReveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.dataset.armed = "true";
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.dataset.revealed = "true";
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="l-reveal">
      {children}
    </div>
  );
}
