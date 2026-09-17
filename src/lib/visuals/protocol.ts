/* ============================================================================
 * protocol.ts — the paragraph that teaches a model to draw.
 *
 * Generated from the catalogue, never written by hand, and only for the kinds
 * Settings leaves on: a kind switched off is not taught, so it is never asked
 * for and its blocks are shown as code. lib/chatContext.ts puts this straight
 * after the persona — the stable front of the system prompt, where START-HERE
 * §8's cache discipline wants anything that does not change between sends.
 *
 * Pure.
 * ========================================================================== */
import { VISUALS, type VisualKind } from "./catalogue";

const FENCE = "```";

export function visualProtocol(enabled: readonly VisualKind[]): string {
  const kinds = VISUALS.filter((v) => enabled.includes(v.kind));
  if (!kinds.length) return "";
  return [
    "=== FIGURES ===",
    "When a picture would explain better than prose — a process, a structure, numbers side by side, how a function " +
      "behaves — draw one in a fenced code block. Only when it helps: a figure that decorates is noise.",
    "",
    ...kinds.map((v) => `- ${FENCE}${v.fences[0]} — ${v.teach}`),
    "",
    "Put a sentence before a figure saying what to look at. Never leave the answer only in the figure; the prose must " +
      "stand on its own. One idea per figure."
  ].join("\n");
}
