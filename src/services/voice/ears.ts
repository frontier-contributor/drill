/* ============================================================================
 * ears.ts — what turns someone's voice into the words the model is sent.
 *
 * Two kinds, one question each is asked.
 *
 * **Hosted** — a backend's /audio/transcriptions, through AI.transcribe(), so
 * every recording is on the run transcript and in the ledger. It is handed a
 * finished recording and hands back its text. Accurate, punctuated, and on
 * Groq fast enough that the eager pause in lib/voice/turns.ts usually hides it
 * completely.
 *
 * **Browser** — the Web Speech API. Free, needs no key, and streams words
 * while they are being said, which is what makes live captions possible. It
 * runs its own microphone, so it only ever *offers* text: capture.ts still
 * decides when someone is speaking, and this is asked what it heard since.
 * Chrome's continuous recognition ends itself after a while of silence, so it
 * is restarted for as long as the call lasts.
 *
 * Which one is used is decided the way Listening decides its voice
 * (services/speech/choice.ts): what Settings asks for if it can work, else the
 * fastest hosted engine with a key saved, else the browser's own — and a
 * sentence saying why when none can.
 * ========================================================================== */

import * as AI from "@/services/ai";
import * as store from "@/services/store";
import { recognitionTag } from "@/lib/voice/langs";
import type { HearEngineId } from "@/types";

export interface Ears {
  id: HearEngineId;
  /** What the voice bar calls it: "whisper-large-v3-turbo via Groq". */
  label: string;
  /** Hosted only: the text of a finished recording. */
  transcribe?(wav: Blob, seconds: number, signal: AbortSignal): Promise<string>;
  /** Browser only: from now on, collect what is heard as a new utterance. */
  mark?(): void;
  /** Browser only: what has been heard since `mark`, finished or not. */
  heard?(): { text: string; final: boolean };
  /** Browser only: called with each new piece of live text. */
  onLive?(fn: (text: string) => void): void;
  close(): void;
}

const HOSTED_ORDER: Exclude<HearEngineId, "browser">[] = ["groq", "openrouter", "custom"];

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** The tag the browser's recognition listens with — the language chosen
 *  under Settings → Voice, or this browser's own. */
export function listenLang(): string {
  const s = store.settings();
  return recognitionTag(s.talk.lang, (typeof navigator !== "undefined" && navigator.language) || "en-US", s.lang === "hinglish");
}

function hostedModel(id: Exclude<HearEngineId, "browser">): string {
  return store.settings().talk.hearModels[id] || AI.BACKENDS[id].hear?.defaultModel || "";
}

/** Whether an engine can hear right now, and why not when it cannot. */
export function earsVerdict(id: HearEngineId): { can: boolean; why: string } {
  if (id === "browser") {
    return recognitionCtor()
      ? { can: true, why: "" }
      : { can: false, why: "This browser has no speech recognition of its own. Add a Groq or OpenRouter key to hear you." };
  }
  if (id === "custom" && !AI.speechCreds("custom").configured) {
    return { can: false, why: "Set up your server first under Settings → Connection." };
  }
  const r = AI.hearReady(id);
  return { can: r.ok, why: r.why || "" };
}

/** Which ears would hear you if voice started now. */
export function chooseEars(): { id: HearEngineId | null; why: string; fellBack: string | null } {
  const asked = store.settings().talk.ears;
  if (asked) {
    const v = earsVerdict(asked);
    if (v.can) return { id: asked, why: "", fellBack: null };
    const auto = chooseAuto();
    return { id: auto, why: auto ? "" : v.why, fellBack: auto ? v.why : null };
  }
  const id = chooseAuto();
  return { id, why: id ? "" : earsVerdict("browser").why, fellBack: null };
}

function chooseAuto(): HearEngineId | null {
  for (const id of HOSTED_ORDER) if (earsVerdict(id).can) return id;
  return earsVerdict("browser").can ? "browser" : null;
}

export function earsLabel(id: HearEngineId): string {
  if (id === "browser") return "this browser's recognition";
  const model = hostedModel(id).split("/").pop();
  return `${model} via ${AI.BACKENDS[id].label}`;
}

export function openEars(id: HearEngineId): Ears {
  if (id !== "browser") {
    return {
      id,
      label: earsLabel(id),
      async transcribe(wav, seconds, signal) {
        /* Named when one was chosen: Whisper guessing the language of a
           two-word phrase is where "yes, go on" comes back as Welsh. */
        const language = store.settings().talk.lang || undefined;
        const r = await AI.transcribe(wav, seconds, { engine: id, model: hostedModel(id) }, { language, signal });
        return r.text;
      },
      close() {
        /* nothing held */
      }
    };
  }
  return openBrowserEars();
}

function openBrowserEars(): Ears {
  const found = recognitionCtor();
  if (!found) throw new Error(earsVerdict("browser").why);
  const Ctor: RecognitionCtor = found;
  let rec: RecognitionLike | null = null;
  let closed = false;
  let restarts = 0;
  /* Finished pieces since the last mark, and the unfinished one. `carried`
     is what an earlier recognition session heard since the mark — Chrome ends
     a session on its own after a quiet spell, and the new one starts its
     result list from nothing. */
  let carried: string[] = [];
  let finals: string[] = [];
  let interim = "";
  /* The browser's result list only grows within one recognition session.
     Results before `fromIndex` belong to an utterance before the mark;
     `seen` is how long the list is now, which is where the next one starts. */
  let fromIndex = 0;
  let seen = 0;
  let listeners: ((t: string) => void)[] = [];

  const text = () => [...carried, ...finals, interim].join(" ").replace(/\s+/g, " ").trim();

  function start() {
    if (closed) return;
    const r = new Ctor();
    r.lang = listenLang();
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    fromIndex = 0;
    seen = 0;
    r.onresult = (e) => {
      seen = e.results.length;
      const done: string[] = [];
      let live = "";
      for (let i = fromIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) done.push(res[0].transcript);
        else live += res[0].transcript;
      }
      finals = done;
      interim = live;
      restarts = 0;
      const t = text();
      for (const fn of listeners) fn(t);
    };
    r.onerror = (e) => {
      /* "no-speech" and "aborted" are the ordinary end of a quiet stretch.
         Being refused is not, and is not retried. */
      if (e.error === "not-allowed" || e.error === "service-not-allowed") closed = true;
    };
    r.onend = () => {
      rec = null;
      if (closed) return;
      /* What was heard so far is kept, so a sentence spanning the restart
         survives it. */
      carried = [...carried, ...finals, ...(interim ? [interim] : [])];
      finals = [];
      interim = "";
      restarts++;
      setTimeout(start, Math.min(2000, 100 * restarts));
    };
    try {
      r.start();
      rec = r;
    } catch {
      setTimeout(start, 500);
    }
  }
  start();

  return {
    id: "browser",
    label: earsLabel("browser"),
    mark() {
      carried = [];
      finals = [];
      interim = "";
      fromIndex = seen;
    },
    heard() {
      return { text: text(), final: !interim };
    },
    onLive(fn) {
      listeners.push(fn);
    },
    close() {
      closed = true;
      listeners = [];
      try {
        rec?.abort();
      } catch {
        /* already stopped */
      }
      rec = null;
    }
  };
}
