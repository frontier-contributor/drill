/* ============================================================================
 * videoSpec.ts — what a clip is asked to be, within what the model takes.
 *
 * A video request with a value the model does not take is refused outright —
 * OpenRouter answers 400 and lists what it would have accepted — and a clip
 * is the most expensive thing this app makes. So the thread's dials (what you
 * chose) and the request (what is sent) are two different things, and this is
 * the only place one becomes the other:
 *
 *  - a value the model takes is sent as chosen;
 *  - a value it does not take falls back to a sensible one it does, and the
 *    composer shows that value, not the stale choice;
 *  - a model the listing has never heard of is sent exactly what was chosen,
 *    and left to say so — unknown is not no.
 *
 * The default length is the short one. A first clip is a test of the prompt,
 * and eight seconds of Veo at 4K is $2.40.
 *
 * Pure.
 * ========================================================================== */
import type { VideoCaps } from "@/lib/mediaCaps";
import type { VideoSpec } from "@/types/chat";

/** The length a new clip starts at: five seconds where the model offers it,
 *  otherwise the shortest of at least four, otherwise the shortest. */
export function defaultSeconds(durations: number[]): number {
  if (durations.includes(5)) return 5;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted.find((d) => d >= 4) ?? sorted[0];
}

function pick(list: string[] | undefined, want: string | undefined, prefer: string[]): string | undefined {
  if (!list?.length) return undefined;
  if (want && list.includes(want)) return want;
  return prefer.find((p) => list.includes(p)) ?? list[0];
}

/** What will be sent for this spec to this model. */
export function effectiveVideo(spec: VideoSpec | undefined, caps: VideoCaps | undefined): VideoSpec {
  const out: VideoSpec = {};
  if (!caps) {
    /* Not in the listing: send what was chosen, and nothing that was not. */
    if (spec?.seconds) out.seconds = spec.seconds;
    if (spec?.resolution) out.resolution = spec.resolution;
    if (spec?.aspect) out.aspect = spec.aspect;
    if (spec?.audio === false) out.audio = false;
    return out;
  }
  if (caps.durations?.length) out.seconds = spec?.seconds && caps.durations.includes(spec.seconds) ? spec.seconds : defaultSeconds(caps.durations);
  out.resolution = pick(caps.resolutions, spec?.resolution, ["720p", "768p", "1080p"]);
  out.aspect = pick(caps.aspects, spec?.aspect, ["16:9"]);
  if (caps.audio) out.audio = spec?.audio !== false;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as VideoSpec;
}

/** "0:42" — for the line that says how long it has been making the clip. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
