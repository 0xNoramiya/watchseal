"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { playSfx } from "@/lib/sfx";

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
    const timers: number[] = [];
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.dataset.revealed = "true";
          io.disconnect();
          // A soft bubble as the stylus reaches each annotated version (silent until the user has interacted).
          el.querySelectorAll<HTMLElement>(".l-callouts span").forEach((span) => {
            const delay = parseFloat(getComputedStyle(span).getPropertyValue("--delay")) || 0;
            timers.push(window.setTimeout(() => playSfx("blub"), delay * 1000 + 120));
          });
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);
  return (
    <div ref={ref} className="l-reveal">
      {children}
    </div>
  );
}
