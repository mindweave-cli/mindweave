/**
 * PulseDot — the dot of a row whose work is still going: white, breathing between bright and dim.
 *
 * Every pulsing dot reads the same clock, so two rows working at once breathe together rather
 * than flickering out of step. Each one re-renders itself a few times a second and nothing else;
 * through the framebuffer that is one cell written per step.
 *
 * White only, like every tool dot: the pulse says "working", and a still dot says "done". On a
 * terminal without colour the shades cannot show, so the dot blinks between normal and dim.
 */
import { useEffect, useState } from "react";
import { Text } from "ink";
import chalk from "chalk";
import { ACCENT } from "../theme.js";

/** One step of the breath, in milliseconds. Six steps make a cycle of about a second. */
export const PULSE_STEP_MS = 160;
const SHADES = ["#ffffff", "#d4d4d4", "#9e9e9e", "#6e6e6e", "#9e9e9e", "#d4d4d4"];

/** Where every dot is in its breath right now (pure, from the clock). */
export function pulsePhase(now: number): number {
  return Math.floor(now / PULSE_STEP_MS) % SHADES.length;
}

/** `base` blended toward the dark ground by `t` (0 = the colour itself, 1 = nearly gone). */
function fade(base: string, t: number): string {
  const n = parseInt(base.slice(1), 16);
  const ground = [0x16, 0x1a, 0x18];
  const mix = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c, i) => Math.round(c + (ground[i]! - c) * t));
  return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
}
/** The breath of the status line's dot: the accent green, bright to dim, on the same clock. */
const GREEN_SHADES = [0, 0.18, 0.4, 0.62, 0.4, 0.18].map((t) => fade(ACCENT, t));

export function PulseDot({ glyph = "●", tone = "white" }: { glyph?: string; tone?: "white" | "green" }) {
  const [phase, setPhase] = useState(() => pulsePhase(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setPhase(pulsePhase(Date.now())), PULSE_STEP_MS);
    return () => clearInterval(id);
  }, []);
  if (chalk.level === 0) return <Text dimColor={phase >= 2 && phase <= 4}>{glyph}</Text>;
  return <Text color={(tone === "green" ? GREEN_SHADES : SHADES)[phase]}>{glyph}</Text>;
}
