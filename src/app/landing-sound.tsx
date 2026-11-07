"use client";

import { useEffect } from "react";
import { playSfx, preloadSfx, setSoundEnabled, useSoundEnabled, type Sfx } from "@/lib/sfx";

/** Plays the sound named in data-sfx when such an element is clicked (lets server markup opt in). */
export function SfxClicks() {
  useEffect(() => {
    preloadSfx();
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-sfx]");
      if (el?.dataset.sfx) playSfx(el.dataset.sfx as Sfx);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}

export function SoundToggle() {
  const on = useSoundEnabled();
  return (
    <button className="l-sound" onClick={() => setSoundEnabled(!on)} aria-pressed={on}>
      {on ? "Sound on" : "Sound off"}
    </button>
  );
}
