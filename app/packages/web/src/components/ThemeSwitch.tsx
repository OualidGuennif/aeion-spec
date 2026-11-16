// Spec: knowledge/components/spec-studio.md
"use client";

import { useEffect, useState } from "react";
import type { ThemeMode } from "@aeion-spec/shared";

const OPTIONS: Array<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "night", label: "Dark" },
  { id: "auto", label: "Auto" },
];

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem("aeion-theme");
    return v === "light" || v === "night" || v === "auto" ? v : "auto";
  } catch {
    return "auto";
  }
}

function applyTheme(mode: ThemeMode) {
  const dark = mode === "night" || (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function ThemeSwitch() {
  const [mode, setMode] = useState<ThemeMode>("auto");

  useEffect(() => {
    const stored = readStored();
    setMode(stored);
    applyTheme(stored);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      if (readStored() === "auto") applyTheme("auto");
    };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const choose = (next: ThemeMode) => {
    setMode(next);
    try {
      localStorage.setItem("aeion-theme", next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    applyTheme(next);
  };

  return (
    <div className="segmented segmented-sm theme-switch" role="group" aria-label="Color theme">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={mode === o.id}
          className={`segment ${mode === o.id ? "active" : ""}`}
          onClick={() => choose(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
