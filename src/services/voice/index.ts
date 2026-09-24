/* ============================================================================
 * services/voice — the one voice conversation, wired to the real parts.
 *
 * session.ts is the state machine and takes every part injected; this file is
 * the only place that supplies the real ones: this browser's microphone, the
 * ears Settings chose, the voice Listening already reads with, and one
 * AudioContext for the call — made inside the click, because a context made
 * after an await starts suspended on Safari and hears nothing.
 *
 * One voice at a time: starting a call stops whatever Listen was reading.
 * ========================================================================== */

import * as store from "@/services/store";
import { player } from "@/services/speech/player";
import { createTalkEngine, deviceChoice, resolveChoice } from "@/services/speech/choice";
import { createVoiceSession } from "./session";
import { Mouth } from "./mouth";
import { openCapture } from "./capture";
import { chooseEars, openEars } from "./ears";

export type { VoicePhase, VoiceState, Brain } from "./session";
export { chooseEars, earsVerdict, earsLabel } from "./ears";

let ctx: AudioContext | null = null;

export const voice = createVoiceSession({
  prepare(hooks, spend) {
    const ears = chooseEars();
    if (!ears.id) throw new Error(ears.why || "Nothing here can hear you.");
    const choice = resolveChoice();
    if (!choice) {
      throw new Error("Nothing here can speak. Add a key under Settings → Connection, or use a browser with voices of its own.");
    }
    player.stop();

    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error("This browser cannot process audio for voice mode.");
    ctx = new AC();
    const decode = (blob: Blob) => blob.arrayBuffer().then((b) => (ctx ? ctx.decodeAudioData(b) : Promise.reject(new Error("closed"))));

    const media = {
      play: () => undefined,
      pause: () => voice.interrupt(),
      stop: () => voice.stop()
    };
    let mouth: Mouth | null = null;
    const engine = createTalkEngine(choice, {
      title: "Voice conversation",
      media,
      onSpend: spend,
      onAudio: (clip, blob, el) => mouth?.onAudio(clip, blob, el)
    });
    mouth = new Mouth(engine, hooks, {
      fallback: () => {
        const device = deviceChoice();
        return device ? createTalkEngine(device, { title: "Voice conversation", media, onSpend: spend }) : null;
      },
      decode
    });
    return mouth;
  },
  openCapture: () => {
    if (!ctx) return Promise.reject(new Error("Voice was not started from a click."));
    return openCapture(ctx);
  },
  openEars: () => {
    const id = chooseEars().id;
    if (!id) throw new Error("Nothing here can hear you.");
    return openEars(id);
  },
  talk: () => store.settings().talk,
  now: () => performance.now(),
  teardown() {
    const c = ctx;
    ctx = null;
    void c?.close().catch(() => undefined);
  }
});

/** Whether voice mode can start here at all, and the sentence when it cannot —
 *  for the composer's button, before anyone presses it. */
export function voiceReady(): { ok: boolean; why: string } {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, why: "Voice needs a microphone, which this page cannot use — it must be served over HTTPS or from localhost." };
  }
  const ears = chooseEars();
  if (!ears.id) return { ok: false, why: ears.why };
  if (!resolveChoice()) return { ok: false, why: "Nothing here can speak. Add a key under Settings → Connection." };
  return { ok: true, why: "" };
}
