/* ============================================================================
 * session.ts — one voice conversation, from the click that opens it to the
 * click that ends it.
 *
 * Everything else in services/voice is a part; this is where they meet:
 *
 *   capture  →  lib/voice/turns  →  ears  →  brain  →  lib/voice/chunker  →  mouth
 *
 * It is a module-level state machine with the subscribe/getVersion shape
 * every store here has, so the voice bar, the full-screen stage and the
 * composer's button all read one answer to "what is voice doing". And like
 * services/agent/loop.ts it takes every part injected: session.test.ts drives
 * a whole conversation — interruption, echo, the floor held, a reply cut back
 * — with fakes, no microphone and no network.
 *
 * The rules, each of them a way these interfaces go wrong:
 *
 *   **An interruption is not trusted until it has been heard.** Talking over a
 *   reply pauses it at once — that is what makes it feel responsive — but it
 *   is only stopped once the words come back and are neither noise nor the
 *   app's own sentence leaking into the microphone. If they are, the reply
 *   carries on from where it paused.
 *
 *   **What was not heard was not said.** A reply stopped part-way is cut back
 *   to the sentence that was playing (ChatContext.cutReply), because the next
 *   request replays the history and a model that remembers saying things
 *   nobody heard is answering a different conversation.
 *
 *   **Ending the call does not destroy the answer.** A reply still being
 *   written when you end the call carries on into the thread as text. The
 *   voice stops; the work does not.
 *
 *   **Every state is a fact.** "Thinking" means a request is open, "speaking"
 *   means sound has started. Nothing here changes phase on a timer.
 * ========================================================================== */

import { TIMING, TurnTaker, type TurnEvent } from "@/lib/voice/turns";
import { Chunker, cutReply, type SpokenChunk } from "@/lib/voice/chunker";
import { isEcho, worthAnswering } from "@/lib/voice/heard";
import type { Capture } from "./capture";
import type { Ears } from "./ears";
import type { MouthHooks } from "./mouth";
import type { VoiceStatus, VoiceTurn } from "@/context/ChatContext";
import type { TalkSettings, VoiceStyle } from "@/types";

export type VoicePhase = "off" | "starting" | "listening" | "hearing" | "thinking" | "speaking" | "error";

export interface VoiceState {
  phase: VoicePhase;
  muted: boolean;
  /** The floor is held: no pause ends the turn until it is let go. */
  locked: boolean;
  /** What you are saying, live where the ears can say — or what was heard. */
  caption: string;
  /** The sentence being said to you. */
  saying: string;
  /** What it is doing about your question: "Searching your record…". */
  status: string;
  /** Worth a line, not an error: "Didn't catch that". Cleared by the next turn. */
  notice: string | null;
  /** Why the call could not start, or stopped. */
  error: string | null;
  earsLabel: string;
  voiceLabel: string;
  /** "full": you can simply talk over it. "half": the app cannot hear past its
   *  own voice here, so interrupting takes a tap, a key, or speaking up. */
  duplex: "full" | "half";
  style: VoiceStyle;
  /** This reply put something on screen — code, a figure, a table — which the
   *  full-screen view cannot show, and says so. */
  onScreen: boolean;
}

/** The part of Mouth the session drives — the real one, or a fake. */
export interface MouthLike {
  readonly cancellable: boolean;
  readonly speaking: boolean;
  readonly busy: boolean;
  readonly current: SpokenChunk | null;
  readonly label: string;
  begin(): void;
  say(chunk: SpokenChunk): void;
  end(): void;
  pause(): void;
  resume(): void;
  stop(): SpokenChunk | null;
  level(now: number): number;
  release(): void;
}

/** ChatContext, as the session needs it. Built by ChatView from refs, so it
 *  always reaches the current conversation. */
export interface Brain {
  ask(text: string, voice: VoiceTurn): Promise<void>;
  cut(turnId: string, text: string): void;
  stop(): void;
  /** What saying a reply cost, for the thread's running total — the same
   *  place a reply read aloud with Listen puts its cost. */
  spend?(chars: number, cost: number | undefined): void;
}

export interface SessionDeps {
  /** Must run inside the click: builds the voice (and on the real path the
   *  AudioContext) while the browser still counts it as a user gesture. */
  prepare(hooks: MouthHooks, spend: (chars: number, cost: number | undefined) => void): MouthLike;
  openCapture(): Promise<Capture>;
  openEars(): Ears;
  talk(): TalkSettings;
  now(): number;
  /** Close anything prepare() opened. */
  teardown(): void;
}

interface Asking {
  turnId: string | null;
  chunker: Chunker;
  acc: string;
  done: boolean;
  /** The last chunk whose sound started — where an interruption cuts to. */
  heard: SpokenChunk | null;
  filler: boolean;
}

const FILLER_GEN = -1;

function initial(): VoiceState {
  return {
    phase: "off",
    muted: false,
    locked: false,
    caption: "",
    saying: "",
    status: "",
    notice: null,
    error: null,
    earsLabel: "",
    voiceLabel: "",
    duplex: "full",
    style: "talk",
    onScreen: false
  };
}

export interface VoiceSession {
  subscribe(fn: () => void): () => void;
  getVersion(): number;
  get(): VoiceState;
  /** Call from inside the click. Resolves once listening, or with the error. */
  start(brain: Brain, style: VoiceStyle): Promise<void>;
  stop(): void;
  setMuted(on: boolean): void;
  /** Hold the floor, or let it go — letting go ends the turn at once. */
  setLocked(on: boolean): void;
  /** Stop what it is saying and listen. The tap on the orb. */
  interrupt(): void;
  setStyle(style: VoiceStyle): void;
  /** How loud the microphone and the voice are right now, 0..1 each. */
  levels(): { mic: number; voice: number };
}

export function createVoiceSession(deps: SessionDeps): VoiceSession {
  let state = initial();
  let version = 0;
  const listeners = new Set<() => void>();

  let brain: Brain | null = null;
  let mouth: MouthLike | null = null;
  let capture: Capture | null = null;
  let ears: Ears | null = null;
  let turns: TurnTaker | null = null;
  let micLevel = 0;
  let asking: Asking | null = null;
  /** A reply was paused because someone started talking over it. */
  let barge = false;
  /** Transcription started at the eager pause, maybe used at the end. */
  let spec: { ctl: AbortController; result: Promise<string | null> } | null = null;
  /** Bumped on every start and stop, so a late promise from an ended call
   *  cannot touch the next one. */
  let epoch = 0;

  function set(patch: Partial<VoiceState>) {
    state = { ...state, ...patch };
    version++;
    listeners.forEach((l) => l());
  }

  const live = (my: number) => my === epoch && state.phase !== "off";

  /* ----------------------------------------------------------- duplex -- */

  function duplex(): "full" | "half" {
    return capture?.echoCancelled && mouth?.cancellable ? "full" : "half";
  }

  /** The app has started or stopped making sound. */
  function replying(on: boolean) {
    if (!turns || !capture) return;
    const d = duplex();
    turns.replyPlaying(on ? d : null);
    /* Without echo cancellation the bar for "a person" rises while the app
       talks, so its own voice leaking into the microphone is not a voice. */
    capture.setMargin(on && d === "half" ? 22 : 12);
    if (state.duplex !== d) set({ duplex: d });
  }

  /* ------------------------------------------------------------ mouth -- */

  const mouthHooks: MouthHooks = {
    started(chunk) {
      replying(true);
      /* The line said while a lookup runs is not the answer: the call is
         still thinking, and saying so is the honest state. */
      if (chunk.gen === FILLER_GEN) {
        set({ saying: chunk.text });
        return;
      }
      if (asking) asking.heard = chunk;
      set({ phase: barge ? state.phase : "speaking", saying: chunk.text, ...(chunk.cue ? { onScreen: true } : {}) });
    },
    drained() {
      if (asking && !asking.done) return;
      asking = null;
      replying(false);
      if (state.phase === "speaking" || state.phase === "thinking") set({ phase: "listening", saying: "", status: "" });
    },
    failed(err, fellBack) {
      set({
        notice: fellBack ? "The voice failed, so this device's voice is taking over. " + err.message : err.message,
        voiceLabel: mouth?.label || state.voiceLabel,
        duplex: duplex()
      });
    }
  };

  /* ------------------------------------------------------------- turns -- */

  function onFrame(f: { speech: boolean; level: number; t: number; ms: number }) {
    micLevel = f.level;
    if (!turns || state.muted) return;
    /* Interrupting by voice switched off: while it talks, nothing said is a
       turn — only a tap or a key stops it. */
    const deaf = !deps.talk().bargeIn && !!mouth?.speaking && !barge;
    for (const e of turns.frame(f.speech && !deaf, f.t, f.ms)) onTurn(e);
  }

  function onTurn(e: TurnEvent) {
    const my = epoch;
    switch (e.type) {
      case "start":
        capture?.begin();
        ears?.mark?.();
        /* Speaking while a request is open and nothing has been said yet is
           still an interruption — of the thinking, not of a voice. */
        if (asking) barge = true;
        set({ phase: "hearing", caption: "", notice: null });
        return;
      case "barge":
        barge = true;
        mouth?.pause();
        capture?.begin();
        ears?.mark?.();
        set({ phase: "hearing", caption: "", notice: null });
        return;
      case "eager":
        speculate();
        return;
      case "resume":
        spec?.ctl.abort();
        spec = null;
        return;
      case "discard":
        spec?.ctl.abort();
        spec = null;
        capture?.end();
        settleNothing();
        return;
      case "end":
        void finishTurn(e.voiced, my);
        return;
    }
  }

  /** Start transcribing what has been said so far, at the first pause. */
  function speculate() {
    if (!ears?.transcribe || !capture) return;
    const rec = capture.snapshot();
    if (!rec) return;
    const ctl = new AbortController();
    const my = epoch;
    const result = ears
      .transcribe(rec.wav, rec.seconds, ctl.signal)
      .then((t) => t)
      .catch(() => null);
    spec = { ctl, result };
    void result.then((text) => {
      if (!live(my) || !spec || spec.ctl !== ctl || text == null || !turns) return;
      for (const e of turns.hint(text, capture?.now() ?? deps.now())) onTurn(e);
    });
  }

  /** Whatever was going on before someone spoke carries on. */
  function settleNothing() {
    if (barge) {
      barge = false;
      mouth?.resume();
      set({ phase: mouth?.speaking ? "speaking" : asking ? "thinking" : "listening" });
      return;
    }
    set({ phase: asking ? "thinking" : "listening" });
  }

  async function finishTurn(voiced: number, my: number) {
    const rec = capture?.snapshot() || null;
    capture?.end();
    const pending = spec;
    spec = null;
    set({ phase: barge ? "hearing" : "thinking" });

    let text = "";
    try {
      text = await transcript(rec, pending);
    } catch (err) {
      if (!live(my)) return;
      set({ notice: "Didn't catch that — " + ((err as Error)?.message || "the transcription failed.") });
      settleNothing();
      return;
    }
    if (!live(my)) return;

    if (!worthAnswering(text, voiced / 1000)) {
      if (text.trim()) set({ notice: "Didn't catch that." });
      settleNothing();
      return;
    }
    /* Its own sentence, coming back through the speaker. */
    if (barge && mouth?.current && isEcho(text, mouth.current.text)) {
      settleNothing();
      return;
    }
    if (barge || asking || mouth?.busy) interruptReply();
    barge = false;
    ask(text);
  }

  async function transcript(rec: { wav: Blob; seconds: number } | null, pending: typeof spec): Promise<string> {
    if (ears?.transcribe) {
      /* The speculative transcription was of everything said up to the
         eager pause; nothing but silence has been added since, or `resume`
         would have thrown it away. */
      if (pending) {
        const early = await pending.result;
        if (early != null) return early;
      }
      if (!rec) return "";
      return ears.transcribe(rec.wav, rec.seconds, new AbortController().signal);
    }
    if (ears?.heard) {
      /* The browser's recogniser finishes a beat after the voice stops. Give
         it a moment to turn its live guess into a final one. */
      for (let i = 0; i < 8 && !ears.heard().final; i++) await new Promise((r) => setTimeout(r, 100));
      return ears.heard().text;
    }
    return "";
  }

  /* ------------------------------------------------------------ asking -- */

  /** Stop the reply in progress, and cut the thread back to what was said. */
  function interruptReply() {
    const playing = mouth?.stop() || null;
    const a = asking;
    asking = null;
    replying(false);
    if (!a || !brain) return;
    const said = playing && playing.gen !== FILLER_GEN ? playing : a.heard;
    if (a.turnId) {
      const current = said && said.gen === a.chunker.generation ? said : null;
      brain.cut(a.turnId, current ? cutReply(a.acc, current.rawEnd) : "…");
    }
    if (!a.done) brain.stop();
  }

  function ask(text: string) {
    if (!brain || !mouth) return;
    const chunker = new Chunker();
    const a: Asking = { turnId: null, chunker, acc: "", done: false, heard: null, filler: false };
    asking = a;
    mouth.begin();
    set({ phase: "thinking", caption: text, saying: "", status: "", notice: null, onScreen: false });

    const voice: VoiceTurn = {
      style: state.style,
      onStart(id) {
        if (asking === a) a.turnId = id;
      },
      onText(acc) {
        if (asking !== a) return;
        a.acc = acc;
        for (const c of chunker.push(acc)) mouth?.say(c);
      },
      onStatus(s: VoiceStatus) {
        if (asking !== a) return;
        if (s.kind === "answering") set({ status: "" });
        else if (s.kind === "plan") set({ status: `Planning · ${s.done} of ${s.total}` });
        else {
          set({ status: s.label + "…" });
          /* Said once, while the first lookup runs, and only if nothing has
             been said yet — a model that announced "let me check" itself has
             already filled the silence. */
          if (!a.filler && !a.heard && !mouth?.speaking) {
            a.filler = true;
            mouth?.say({ text: s.label + "…", rawEnd: 0, gen: FILLER_GEN, cue: "filler" });
          }
        }
      },
      onDone(r) {
        if (asking !== a) return;
        a.done = true;
        for (const c of chunker.finish()) mouth?.say(c);
        if (!r.ok && r.error) set({ notice: r.error });
        mouth?.end();
      }
    };
    void brain.ask(text, voice);
    /* send() names the turn synchronously when it takes the message. No name
       means it refused — a reply started some other way is still running —
       and waiting for this one would wait for ever. */
    if (asking === a && !a.turnId) {
      asking = null;
      set({ phase: "listening", notice: "Still finishing the last reply. Say that again in a moment." });
    }
  }

  /* -------------------------------------------------------------- api -- */

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getVersion: () => version,
    get: () => state,

    async start(b, style) {
      if (state.phase !== "off" && state.phase !== "error") return;
      const my = ++epoch;
      brain = b;
      set({ ...initial(), phase: "starting", style });
      try {
        mouth = deps.prepare(mouthHooks, (chars, cost) => brain?.spend?.(chars, cost));
      } catch (err) {
        set({ phase: "error", error: (err as Error)?.message || String(err) });
        return;
      }
      try {
        const cap = await deps.openCapture();
        if (my !== epoch) {
          cap.close();
          return;
        }
        capture = cap;
        ears = deps.openEars();
        turns = new TurnTaker(TIMING[deps.talk().sensitivity]);
        cap.onFrame(onFrame);
        ears.onLive?.((t) => {
          if (my !== epoch || !turns) return;
          if (state.phase === "hearing") set({ caption: t });
          for (const e of turns.hint(t, cap.now())) onTurn(e);
        });
        set({ phase: "listening", earsLabel: ears.label, voiceLabel: mouth.label, duplex: duplex() });
      } catch (err) {
        if (my !== epoch) return;
        teardown();
        set({ phase: "error", error: (err as Error)?.message || String(err) });
      }
    },

    stop() {
      epoch++;
      /* The reply keeps being written into the thread; only the voice stops. */
      asking = null;
      barge = false;
      teardown();
      set({ ...initial(), style: state.style });
    },

    setMuted(on) {
      capture?.setMuted(on);
      if (on) {
        turns?.clear();
        spec?.ctl.abort();
        spec = null;
        capture?.end();
        if (state.phase === "hearing") settleNothing();
      }
      set({ muted: on });
    },

    setLocked(on) {
      if (!turns) return;
      set({ locked: on });
      for (const e of turns.lock(on)) onTurn(e);
    },

    interrupt() {
      if (state.phase === "off" || state.phase === "starting") return;
      interruptReply();
      barge = false;
      turns?.clear();
      set({ phase: "listening", saying: "", status: "" });
    },

    setStyle(style) {
      set({ style });
    },

    levels() {
      return { mic: state.muted ? 0 : micLevel, voice: mouth?.level(deps.now()) ?? 0 };
    }
  };

  function teardown() {
    spec?.ctl.abort();
    spec = null;
    capture?.close();
    capture = null;
    ears?.close();
    ears = null;
    mouth?.release();
    mouth = null;
    turns = null;
    micLevel = 0;
    deps.teardown();
  }
}
