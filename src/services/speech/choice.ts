/* ============================================================================
 * choice.ts — from Settings and what this browser has, to a working voice.
 *
 * lib/speech/availability.ts decides; this file gathers what it decides from
 * — which keys are saved, whether the speech catalogue has loaded, which
 * voices the browser offered — and builds the engine the decision names. The
 * Listen button, the bar and the settings page all ask here, which is what
 * keeps the voice the button promises and the voice that speaks the same.
 *
 * The lists it hands out only ever hold what an engine can actually use:
 * speech models, never chat models, and for each model only the voices that
 * model publishes. A picker built from them cannot be set to something the
 * provider would refuse.
 * ========================================================================== */
import * as AI from "@/services/ai";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import { speechCatalogue, speechPriceFor, type SpeechModel } from "@/services/pricing";
import { formatCost } from "@/lib/tokens";
import {
  chooseEngine,
  deviceVerdict,
  hostedVerdict,
  pickVoice,
  rankDeviceVoices,
  type SpeechVerdict
} from "@/lib/speech/availability";
import * as voices from "./voices";
import { createDeviceEngine } from "./deviceEngine";
import { createAudioEngine } from "./audioEngine";
import { player, type ListenSource, type PlaybackEngine } from "./player";
import type { SpeechChoice, SpeechEngineId } from "@/types";

export const ENGINE_ORDER: SpeechEngineId[] = ["device", "openrouter", "groq", "custom"];

export interface Option {
  id: string;
  label: string;
}

export interface EngineInfo {
  id: SpeechEngineId;
  /** The engine's name in a list. */
  name: string;
  verdict: SpeechVerdict;
  source: "device" | "catalogue" | "fixed" | "typed";
  model: string;
  voice: string;
  /** Speech models this engine can use. Empty for the device and for a typed server. */
  models: Option[];
  /** Voices for the model in use — or the browser's, for the device. */
  voices: Option[];
  /** USD per character: 0 is free, undefined is unknown. */
  perChar?: number;
}

export interface ListenChoice {
  info: EngineInfo;
  /** Why the engine asked for is not the one reading, when it is not. */
  fellBack: string | null;
  /** What the button, the bar and the media overlay call this voice. */
  label: string;
}

function shortModel(model: string): string {
  return model.split("/").pop() || model;
}

/** "Kokoro 82M" out of the catalogue's "hexgrad: Kokoro 82M". */
function modelName(m: SpeechModel): string {
  return (m.name || m.id).replace(/^[^:]+:\s*/, "");
}

export function priceLabel(perChar: number | undefined): string {
  if (perChar === 0) return "free";
  if (perChar == null) return "price unknown";
  return formatCost(perChar * 1000) + " per 1,000 characters";
}

/** The speeds offered wherever a speed is offered. Two is the ceiling because
 *  Chrome's own voices go silent above it, and one list for every engine is
 *  simpler than explaining why two lists differ. */
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function speedLabel(rate: number): string {
  return `${rate}×`;
}

/** Money for reading `chars` characters, or undefined when it cannot be known. */
export function estimate(info: EngineInfo, chars: number): number | undefined {
  return info.perChar == null ? undefined : info.perChar * chars;
}

/* ----------------------------------------------------------------- facts -- */

function deviceInfo(): EngineInfo {
  const list = voices.list();
  const ranked = list ? rankDeviceVoices(list, typeof navigator !== "undefined" ? navigator.language : "en") : [];
  const saved = store.settings().speech.voices.device?.voice || "";
  const voice = ranked.some((v) => v.voiceURI === saved) ? saved : ranked[0]?.voiceURI || "";
  return {
    id: "device",
    name: "This device's voice",
    verdict: deviceVerdict({ supported: voices.supported(), voices: list ? ranked.length : null }),
    source: "device",
    model: "",
    voice,
    models: [],
    voices: ranked.map((v) => ({ id: v.voiceURI, label: `${v.name} · ${v.lang}${v.localService ? "" : " · online"}` })),
    perChar: 0
  };
}

function hostedInfo(id: Exclude<SpeechEngineId, "device">): EngineInfo {
  const be = AI.BACKENDS[id];
  const def = be.speech!;
  const saved = store.settings().speech.voices[id];
  const model = saved?.model || def.defaultModel;
  const creds = AI.speechCreds(id);

  let available: readonly string[] | null | undefined;
  let models: Option[] = [];
  if (def.source === "catalogue") {
    const cat = speechCatalogue();
    available = cat ? cat[model]?.voices : null;
    models = cat
      ? Object.values(cat)
          /* Only what can really be offered: a model that publishes voices to
             choose from, and that a character count can price. */
          .filter((m) => m.voices.length > 0 && m.perChar != null)
          .sort((a, b) => (a.perChar ?? 0) - (b.perChar ?? 0) || modelName(a).localeCompare(modelName(b)))
          .map((m) => ({ id: m.id, label: `${modelName(m)} · ${priceLabel(m.perChar)}` }))
      : [];
  } else if (def.source === "fixed") {
    available = def.models?.[model];
    models = Object.keys(def.models || {}).map((m) => ({ id: m, label: shortModel(m) }));
  }
  if (def.source !== "typed" && !models.some((m) => m.id === model)) {
    models.unshift({ id: model, label: shortModel(model) + (available === undefined ? " · not available" : "") });
  }

  const voice =
    available && available.length ? pickVoice(available, saved?.voice || "", def.defaultVoice) : saved?.voice || def.defaultVoice;

  const verdict: SpeechVerdict =
    id === "custom" && !creds.configured
      ? {
          can: false,
          certain: true,
          why: "Set up your server first: choose “OpenAI-compatible” under Settings → Connection and give it a Base URL."
        }
      : hostedVerdict({
          label: be.label,
          speaks: true,
          needsKey: be.needsKey,
          hasKey: !!creds.apiKey,
          source: def.source,
          model,
          voices: available
        });

  return {
    id,
    name: id === "custom" ? "OpenAI-compatible server" : be.label,
    verdict,
    source: def.source,
    model,
    voice,
    models,
    voices: (available || []).map((v) => ({ id: v, label: v })),
    perChar: speechPriceFor(id, model)
  };
}

export function engineInfo(id: SpeechEngineId): EngineInfo {
  return id === "device" ? deviceInfo() : hostedInfo(id);
}

export function labelOf(info: EngineInfo): string {
  if (info.id === "device") {
    const name = voices.find(info.voice)?.name;
    return name ? `${name} on this device` : "This device's voice";
  }
  return `${shortModel(info.model)} · ${info.voice} via ${info.name}`;
}

/* ---------------------------------------------------------------- choice -- */

let memo: { key: string; value: ListenChoice | null } | null = null;

/** The voice that would read if Listen were pressed now, or null when nothing
 *  here can speak. Recomputed only when something it reads has changed —
 *  every reply on the screen asks, on every render. */
export function resolveChoice(): ListenChoice | null {
  const key = `${store.getVersion()}:${voices.getVersion()}:${speechCatalogue() ? 1 : 0}`;
  if (memo && memo.key === key) return memo.value;

  const infos = Object.fromEntries(ENGINE_ORDER.map((id) => [id, engineInfo(id)])) as Record<SpeechEngineId, EngineInfo>;
  const verdicts = Object.fromEntries(ENGINE_ORDER.map((id) => [id, infos[id].verdict])) as Record<SpeechEngineId, SpeechVerdict>;
  const { engine, fellBack } = chooseEngine(store.settings().speech.engine, verdicts);
  const value = engine ? { info: infos[engine], fellBack, label: labelOf(infos[engine]) } : null;
  memo = { key, value };
  return value;
}

/** Remember a model or voice for one engine. A new model with no voice named
 *  gets that model's default voice, never the previous model's. */
export function setVoice(id: SpeechEngineId, patch: Partial<SpeechChoice>): void {
  const s = store.settings().speech;
  const cur = s.voices[id];
  const next: SpeechChoice = {
    model: patch.model ?? cur?.model ?? "",
    voice: patch.voice ?? (patch.model !== undefined ? "" : cur?.voice ?? "")
  };
  store.updateSettings({ speech: { ...s, voices: { ...s.voices, [id]: next } } });
}

/* --------------------------------------------------------------- playback -- */

/** Put what reading a reply cost on the reply itself, and on its thread's
 *  running total — the same two places a chat reply's own cost lives. */
function recordSpend(source: ListenSource, chars: number, cost: number | undefined): void {
  player.spend(source, chars, cost);
  const c = chatStore.peek(source.conversationId);
  const v = c?.turns.find((t) => t.id === source.turnId)?.variants[source.variant];
  if (!c || !v) return;
  const prev = v.listened;
  v.listened = { chars: (prev?.chars || 0) + chars, cost: cost == null ? prev?.cost : (prev?.cost || 0) + cost };
  chatStore.addUsageTo(c, { promptTokens: 0, completionTokens: 0, cost });
  chatStore.persist(c);
}

export function createEngine(choice: ListenChoice, source: ListenSource): PlaybackEngine {
  const { info } = choice;
  if (info.id === "device") return createDeviceEngine(info.voice, choice.label);
  return createAudioEngine({
    target: { engine: info.id, model: info.model, voice: info.voice },
    label: choice.label,
    title: source.title,
    cacheMB: store.settings().speech.cacheMB,
    media: {
      play: () => player.resume(),
      pause: () => player.pause(),
      stop: () => player.stop(),
      previous: () => player.skip(-1),
      next: () => player.skip(1)
    },
    onSpend: (chars, cost) => recordSpend(source, chars, cost)
  });
}

/**
 * A voice for voice mode: the same engines Listen uses, built from the same
 * choice, so the voice that answers you is the voice Settings → Listening
 * shows. What differs is who it reports to — the call rather than the
 * player — and that each hosted clip's bytes are handed over for the orb.
 * Must be called inside the click that starts the call, like listen().
 */
export function createTalkEngine(
  choice: ListenChoice,
  o: {
    title: string;
    media: { play(): void; pause(): void; stop(): void };
    onSpend(chars: number, cost: number | undefined): void;
    onAudio?: (clip: import("./player").Clip, blob: Blob, el: HTMLAudioElement) => void;
  }
): PlaybackEngine {
  const { info } = choice;
  if (info.id === "device") return createDeviceEngine(info.voice, choice.label);
  return createAudioEngine({
    target: { engine: info.id, model: info.model, voice: info.voice },
    label: choice.label,
    title: o.title,
    cacheMB: store.settings().speech.cacheMB,
    media: { ...o.media, previous: () => undefined, next: () => undefined },
    onSpend: o.onSpend,
    onAudio: o.onAudio
  });
}

/** This device's voice, for when a hosted one fails mid-call. Null when the
 *  browser has none. */
export function deviceChoice(): ListenChoice | null {
  const info = engineInfo("device");
  return info.verdict.can ? { info, fellBack: null, label: labelOf(info) } : null;
}

/** Read a source aloud with whatever voice would read now. Must be called
 *  from inside the click that asked for it — see audioEngine's silence(). */
export function listen(source: ListenSource, from = 0): boolean {
  const choice = resolveChoice();
  if (!choice) return false;
  const s = store.settings().speech;
  player.play(source, createEngine(choice, source), { rate: s.rate, following: s.follow, from });
  return true;
}

/** Carry the reading on from where it is, in the voice that would now be
 *  chosen — after the voice or model was changed mid-reading. */
export function revoice(): void {
  const src = player.get().source;
  const choice = resolveChoice();
  if (!src || !choice || player.get().status === "idle") return;
  player.swapEngine(createEngine(choice, src));
}

/** Rescue a reading whose hosted voice failed, with this device's. */
export function switchToDevice(): void {
  const src = player.get().source;
  const info = engineInfo("device");
  if (!src || !info.verdict.can) return;
  player.swapEngine(createEngine({ info, fellBack: null, label: labelOf(info) }, src));
}

export const SAMPLE_TURN = "voice-sample";

/** A sentence in the chosen voice, for Settings. Played through the same
 *  player as a reply, so it costs, caches and is counted like one. The Voice
 *  page says a different sentence, because there it is the voice that talks
 *  to you rather than the one that reads to you. */
export function playSample(sentence = "This is how replies will sound when they are read aloud."): boolean {
  return listen({
    conversationId: "",
    projectId: "",
    turnId: SAMPLE_TURN,
    variant: 0,
    title: "Voice sample",
    sentences: [sentence]
  });
}
