/* ============================================================================
 * Voice — talking with the assistant, on a page of its own.
 *
 * It was a group near the bottom of Listening, between the reading speed and
 * the audio cache: eight controls for a call, filed under the feature that
 * reads a reply to you. Someone looking for "why does it cut me off" had to
 * guess that the answer lived under reading aloud.
 *
 * The page is laid out in the order a call happens, and starts with the one
 * thing a settings page for a voice can do that a list of dials cannot: let
 * you try it. The orb at the top is the call's own orb, driven here by a short
 * microphone check — it swells with your voice, and what you said comes back
 * written down by the engine the call would use. Beside it is the whole chain
 * at a glance: what hears you, what answers, what speaks. Most "voice doesn't
 * work" is one of those three, and each names itself and links to its group.
 *
 * Then the voice, as tiles you press to hear — the same setting Listening's
 * pickers write, because the app has one voice, not one for reading and
 * another for talking. Then hearing, taking turns, and replies.
 *
 * The check keeps the microphone open for thirty seconds at most, never while
 * a call has it, and never after this page closes.
 * ========================================================================== */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as store from "@/services/store";
import * as AI from "@/services/ai";
import * as voices from "@/services/speech/voices";
import { player } from "@/services/speech/player";
import { SAMPLE_TURN, playSample, priceLabel, resolveChoice, setVoice } from "@/services/speech/choice";
import { loadSpeechCatalogue } from "@/services/pricing";
import { voice, voiceReady } from "@/services/voice";
import { openCapture, type Capture } from "@/services/voice/capture";
import { chooseEars, earsLabel, earsVerdict, openEars, type Ears } from "@/services/voice/ears";
import { TALK_LANGS } from "@/lib/voice/langs";
import { TIMING } from "@/lib/voice/turns";
import { deviceVoiceName, hostedVoiceName, type VoiceName } from "@/lib/speech/names";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useMaybeChat } from "@/context/ChatContext";
import { useSettings } from "@/context/SettingsContext";
import VoiceOrb, { type OrbPhase, type OrbSource } from "@/components/chat/voice/VoiceOrb";
import ModelPicker from "../../ui/ModelPicker";
import SelectRow from "../../ui/SelectRow";
import SwitchRow from "../../ui/SwitchRow";
import TextRow from "../../ui/TextRow";
import Icon from "../../ui/Icon";
import Section from "../Section";
import type { SectionId } from "../catalogue";
import type { HearEngineId, TalkSensitivity, TalkSettings, VoiceStyle } from "@/types";
import "@/styles/voice.css";

function update(patch: Partial<TalkSettings>): void {
  store.updateSettings({ talk: { ...store.settings().talk, ...patch } });
}

const short = (model: string) => model.split("/").pop() || model;
const secs = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;

/** What the sample says here. Listening's says how a reply will be read;
 *  this one is the voice that talks back. */
const SAMPLE = "Hi. This is how I'll sound when we talk.";

function sampleStatus(): "" | "loading" | "playing" {
  const p = player.get();
  if (p.source?.turnId !== SAMPLE_TURN) return "";
  return p.status === "loading" ? "loading" : p.status === "playing" ? "playing" : "";
}

/* ------------------------------------------------------------- the check -- */

interface CheckState {
  phase: "idle" | "opening" | "live" | "error";
  /** A voice is above the room right now. */
  speaking: boolean;
  /** The last phrase is being written down. */
  writing: boolean;
  /** Words as they are said — the browser's recognition only. */
  live: string;
  /** What the last phrase came back as; null until one was said. */
  heard: string | null;
  heardBy: string;
  heardError: string;
  /** Long enough without a voice that the wrong microphone is likely. */
  silent: boolean;
  echo: boolean | null;
  device: string;
  error: string;
}

const IDLE: CheckState = {
  phase: "idle",
  speaking: false,
  writing: false,
  live: "",
  heard: null,
  heardBy: "",
  heardError: "",
  silent: false,
  echo: null,
  device: "",
  error: ""
};

/** The longest the check holds the microphone by itself. */
const CHECK_MS = 30_000;
/** Quiet after a voice before the phrase is written down. A little longer
 *  than a call's quick setting: nothing is waiting on the answer here. */
const PHRASE_END_MS = 800;
/** Less voice than this is a knock on the desk, not a word. */
const MIN_VOICED_MS = 250;
/** Silence this long, open, says more about the microphone than the room. */
const SILENT_HINT_MS = 7000;

interface Held {
  ctx: AudioContext | null;
  cap: Capture | null;
  ears: Ears | null;
  abort: AbortController | null;
  timers: number[];
}

function useMicCheck() {
  const [st, setSt] = useState<CheckState>(IDLE);
  /* Read by the orb on every frame, so it is a ref and never state — fifty
     renders a second to move a canvas would be the page's whole budget. */
  const level = useRef(0);
  const held = useRef<Held>({ ctx: null, cap: null, ears: null, abort: null, timers: [] });
  const patch = useCallback((p: Partial<CheckState>) => setSt((s) => ({ ...s, ...p })), []);

  /** Close the microphone. A phrase already being written down is left to
   *  finish — it has been paid for, and it is the answer the check exists
   *  to give. */
  const stop = useCallback(() => {
    const h = held.current;
    for (const t of h.timers) window.clearTimeout(t);
    h.ears?.close();
    h.cap?.close();
    void h.ctx?.close().catch(() => undefined);
    held.current = { ctx: null, cap: null, ears: null, abort: h.abort, timers: [] };
    level.current = 0;
    setSt((s) => (s.phase === "live" || s.phase === "opening" ? { ...s, phase: "idle", speaking: false, silent: false } : s));
  }, []);

  const finish = useCallback(
    (cap: Capture, ears: Ears | null, voicedMs: number) => {
      const rec = cap.snapshot();
      cap.end();
      if (voicedMs < MIN_VOICED_MS || !rec) return;
      if (!ears) {
        patch({ heard: null, heardError: "Your voice arrives, but nothing here can turn it into words yet — see Hearing you, below." });
        return;
      }
      patch({ writing: true, heardError: "", heardBy: ears.label });
      if (ears.transcribe) {
        const ac = new AbortController();
        held.current.abort = ac;
        ears
          .transcribe(rec.wav, rec.seconds, ac.signal)
          .then((text) => patch({ heard: text.trim(), writing: false }))
          .catch((e: Error) => {
            if (!ac.signal.aborted) patch({ heardError: e.message || "It could not be written down.", writing: false });
          });
        return;
      }
      /* The browser's recognition settles its last words a moment after the
         voice stops. Not one of the timers stop() clears: closing the
         microphone does not unsay what was said. */
      window.setTimeout(() => patch({ heard: ears.heard?.().text.trim() || "", writing: false, live: "" }), 700);
    },
    [patch]
  );

  const start = useCallback(() => {
    if (held.current.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC || !navigator.mediaDevices?.getUserMedia) {
      setSt({ ...IDLE, phase: "error", error: voiceReady().why || "This browser cannot use a microphone here." });
      return;
    }
    /* Made inside the click, for the reason the call makes its own there: a
       context created after an await starts suspended on Safari. */
    const ctx = new AC();
    held.current.ctx = ctx;
    if (sampleStatus()) player.stop();
    const earsId = chooseEars().id;
    setSt((s) => ({ ...IDLE, phase: "opening", heard: s.heard, heardBy: s.heardBy }));

    openCapture(ctx)
      .then((cap) => {
        if (held.current.ctx !== ctx) {
          cap.close();
          return;
        }
        let ears: Ears | null = null;
        try {
          ears = earsId ? openEars(earsId) : null;
        } catch {
          ears = null;
        }
        held.current.cap = cap;
        held.current.ears = ears;
        ears?.onLive?.((t) => patch({ live: t }));

        let phrase: { voiced: number; quiet: number } | null = null;
        let anything = false;
        cap.onFrame((f) => {
          /* Eased, so the orb follows a voice rather than every 20 ms frame. */
          level.current += (f.level - level.current) * 0.5;
          if (f.speech) {
            if (!phrase) {
              phrase = { voiced: 0, quiet: 0 };
              cap.begin();
              ears?.mark?.();
              patch({ speaking: true, silent: false, live: "" });
            }
            anything = true;
            phrase.voiced += f.ms;
            phrase.quiet = 0;
          } else if (phrase) {
            phrase.quiet += f.ms;
            if (phrase.quiet >= PHRASE_END_MS) {
              const voiced = phrase.voiced;
              phrase = null;
              patch({ speaking: false });
              finish(cap, ears, voiced);
            }
          }
        });

        held.current.timers.push(
          window.setTimeout(stop, CHECK_MS),
          window.setTimeout(() => {
            if (!anything) patch({ silent: true });
          }, SILENT_HINT_MS)
        );
        patch({ phase: "live", echo: cap.echoCancelled, device: cap.device });
      })
      .catch((e: Error) => {
        if (held.current.ctx !== ctx) return;
        stop();
        setSt({ ...IDLE, phase: "error", error: e.message });
      });
  }, [finish, patch, stop]);

  /* Leaving the page ends everything, including a phrase still in flight —
     nobody is left to read the answer. */
  useEffect(
    () => () => {
      held.current.abort?.abort();
      stop();
    },
    [stop]
  );

  return { st, level, start, stop };
}

/* ------------------------------------------------------------------ chain -- */

function Chain({ jump }: { jump: (at: SectionId) => void }) {
  const t = store.settings().talk;
  const ears = chooseEars();
  const choice = resolveChoice();
  const conv = useMaybeChat()?.conversation;
  const answers = t.model
    ? short(t.model)
    : conv
      ? `${short(conv.model || AI.resolve().model)} · this chat's`
      : "Each chat's own model";

  /* The voice by the name its tile uses, not the one the system reports —
     "Microsoft David - English (United States)" is a sentence, not a name. */
  const info = choice?.info;
  const speaks = !info
    ? "Nothing yet"
    : info.id === "device"
      ? `${deviceVoiceName(info.voices.find((v) => v.id === info.voice)?.label || info.voice).name} · this device`
      : `${hostedVoiceName(info.voice).name} · ${short(info.model)} via ${info.name}`;
  const hears = ears.id ? earsLabel(ears.id) : "Nothing yet";

  const rows: { k: string; v: string; at: SectionId; warn: boolean }[] = [
    { k: "Hears you", v: hears[0].toUpperCase() + hears.slice(1), at: "voice.hearing", warn: !ears.id },
    { k: "Answers", v: answers, at: "voice.replies", warn: false },
    { k: "Speaks", v: speaks, at: "voice.voice", warn: !info }
  ];
  return (
    <div className="vset-chain">
      {rows.map((r, i) => (
        <button key={r.k} type="button" className={"vset-link" + (r.warn ? " warn" : "")} onClick={() => jump(r.at)}>
          <span className="vset-k">
            <span className="vset-n">{i + 1}</span>
            {r.k}
          </span>
          <span className="vset-v">{r.v}</span>
        </button>
      ))}
    </div>
  );
}

function Check() {
  const { open } = useSettings();
  const call = useSyncExternalStore(voice.subscribe, voice.get, voice.get);
  useStoreSync(player);
  const { st, level, start, stop } = useMicCheck();
  const ready = voiceReady();
  const inCall = call.phase !== "off";
  const sample = sampleStatus();
  const live = st.phase === "live" || st.phase === "opening";

  /* The orb reads these on every frame. Refs, so the source object itself
     never changes and the canvas is never torn down and rebuilt. */
  const now = useRef({ st, ready: ready.ok });
  now.current = { st, ready: ready.ok };
  const source = useMemo<OrbSource>(
    () => ({
      phase(): OrbPhase {
        const c = now.current.st;
        if (c.phase === "opening") return "starting";
        if (c.phase === "live") return c.speaking ? "hearing" : c.writing ? "thinking" : "listening";
        if (c.writing) return "thinking";
        const s = sampleStatus();
        if (s === "loading") return "thinking";
        if (s === "playing") return "speaking";
        if (c.phase === "error") return "error";
        return now.current.ready ? "ready" : "off";
      },
      muted: () => false,
      levels: () => ({ mic: level.current, voice: 0 })
    }),
    [level]
  );

  let head: string;
  let line: string;
  if (inCall) {
    head = "In a conversation";
    line = "The call has the microphone, so the check is off until it ends. The orb is the call's own.";
  } else if (st.phase === "opening") {
    head = "Opening the microphone…";
    line = "The browser may ask first.";
  } else if (st.phase === "live") {
    head = st.speaking ? "Hearing you" : st.writing ? "Writing it down…" : "Listening — say something";
    line = st.live || "Say a sentence the way you would ask a question. It is written down by the engine a call uses.";
  } else if (st.phase === "error") {
    head = "The microphone didn't open";
    line = st.error;
  } else if (ready.ok) {
    head = "Ready to talk";
    line = "Start from any chat — the round button beside an empty box, or";
  } else {
    head = "Not ready yet";
    line = ready.why;
  }

  return (
    <>
      <div className={"vset-hero" + (live ? " live" : "")}>
        <button
          type="button"
          className="vset-orb"
          disabled={inCall}
          onClick={() => (live ? stop() : start())}
          aria-label={live ? "Stop the microphone check" : "Check the microphone"}
        >
          <VoiceOrb size={112} source={inCall ? undefined : source} />
        </button>
        <div className="vset-hero-text">
          <div className="vset-state" aria-live="polite">
            {head}
          </div>
          <div className={"vset-line" + (st.live && st.phase === "live" ? " you" : "")}>
            {line}
            {!inCall && st.phase === "idle" && ready.ok && (
              <>
                {" "}
                <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>V</kbd>.
              </>
            )}
          </div>
          <div className="vset-actions">
            <button type="button" className={"btn sm" + (live ? "" : " pri")} disabled={inCall} onClick={() => (live ? stop() : start())}>
              <Icon name={live ? "stop" : "mic"} size={13} />
              {live ? "Stop" : "Check the microphone"}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={inCall || live || !resolveChoice()}
              onClick={() => (sample ? player.stop() : playSample(SAMPLE))}
            >
              <Icon name={sample ? "stop" : "speaker"} size={13} />
              {sample ? "Stop" : "Hear its voice"}
            </button>
          </div>
        </div>
      </div>

      {(st.heard !== null || st.heardError) && (
        <div className={"vset-heard" + (st.heardError ? " warn" : "")}>
          {st.heardError ? (
            st.heardError
          ) : st.heard ? (
            <>
              <span className="vset-quote">“{st.heard}”</span>
              <span className="vset-by">heard by {st.heardBy}</span>
            </>
          ) : (
            "A voice arrived but no words came back — try again a little closer to the microphone."
          )}
        </div>
      )}
      {st.silent && st.phase === "live" && (
        <p className="sset-note warn">
          Nothing loud enough to be a voice yet. If you are talking, the browser may have the wrong microphone — the
          system's sound settings choose which one it gets.
        </p>
      )}
      {st.echo !== null && (
        <p className={"sset-note" + (st.echo ? " ok" : " warn")}>
          {st.device ? `${st.device}. ` : ""}
          {st.echo
            ? "Echo cancellation is on, so in a call you can interrupt it just by talking."
            : "This microphone has no echo cancellation, so a call needs a firmer voice to interrupt it. Headphones help."}
        </p>
      )}

      <Chain jump={(at) => open("voice", at)} />
      <p className="sset-note">
        A phrase you say here is written down like any in a call — on a hosted engine that is a fraction of a cent, on the{" "}
        <button className="textlink" onClick={() => open("usage", "usage.cost")}>
          Usage page
        </button>{" "}
        under “voice”. The check closes the microphone by itself after thirty seconds.
      </p>
    </>
  );
}

/* ----------------------------------------------------------------- voices -- */

/** Tiles shown before "all of them" — enough to choose from, few enough to
 *  hear every one in a minute. The one in use is always among them. */
const TILE_LIMIT = 9;

function Voices() {
  const { open } = useSettings();
  useStoreSync(player);
  const inCall = useSyncExternalStore(voice.subscribe, voice.get, voice.get).phase !== "off";
  const [all, setAll] = useState(false);
  const choice = resolveChoice();
  const info = choice?.info;
  const sample = sampleStatus();

  if (!info) {
    return (
      <p className="sset-note warn">
        Nothing here can speak yet. Add an OpenRouter key under{" "}
        <button className="textlink" onClick={() => open("connection", "connection.provider")}>
          Connection
        </button>
        , or use a browser with voices of its own.
      </p>
    );
  }

  const named: (VoiceName & { id: string })[] = (
    info.voices.length ? info.voices : info.voice ? [{ id: info.voice, label: info.voice }] : []
  ).map((v) => ({ id: v.id, ...(info.id === "device" ? deviceVoiceName(v.label) : hostedVoiceName(v.id)) }));
  /* Collapsed, the tiles are a spread rather than the top of the list: one
     from each accent in turn. A catalogue sorted by id otherwise opens on
     nine American women and hides that there is anything else. */
  const groups = new Map<string, typeof named>();
  for (const v of named) groups.set(v.detail, [...(groups.get(v.detail) || []), v]);
  const spread: typeof named = [];
  for (let i = 0; spread.length < Math.min(TILE_LIMIT, named.length); i++) {
    for (const g of groups.values()) if (g[i] && spread.length < TILE_LIMIT) spread.push(g[i]);
  }
  let shown = all ? named : spread;
  if (!all && !shown.some((v) => v.id === info.voice)) {
    const cur = named.find((v) => v.id === info.voice);
    if (cur) shown = [...shown.slice(0, TILE_LIMIT - 1), cur];
  }

  /* Choosing is hearing: the press that picks a voice plays it, inside the
     same click, which is what lets a hosted voice start at all on Safari.
     Not during a call — a sample would talk over the call's own voice, and
     the microphone would hear it as you. */
  const pick = (id: string) => {
    if (id === info.voice && sample) {
      player.stop();
      return;
    }
    if (id !== info.voice) setVoice(info.id, { voice: id });
    if (!inCall) playSample(SAMPLE);
  };

  return (
    <>
      {shown.length > 0 && (
        <div className="vtiles" role="radiogroup" aria-label="Voices">
          {shown.map((v) => {
            const on = v.id === info.voice;
            const state = on ? sample : "";
            return (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={"vtile" + (on ? " on" : "") + (state ? " " + state : "")}
                title={inCall ? "Use this voice from the next conversation" : on && state ? "Stop" : "Hear this voice"}
                onClick={() => pick(v.id)}
              >
                <span className="vtile-play" aria-hidden="true">
                  {state === "playing" ? (
                    <span className="vtile-bars">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <Icon name="play" size={11} />
                  )}
                </span>
                <span className="vtile-name">{v.name}</span>
                {v.detail && <span className="vtile-detail">{v.detail}</span>}
              </button>
            );
          })}
        </div>
      )}
      {named.length > TILE_LIMIT && (
        <div className="btnrow">
          <button type="button" className="btn sm" onClick={() => setAll((a) => !a)}>
            {all ? "Fewer voices" : `All ${named.length} voices`}
          </button>
        </div>
      )}
      {choice.fellBack && <p className="sset-note warn">{choice.fellBack} Speaking with {choice.label} until then.</p>}
      {inCall && <p className="sset-note">A conversation is on, so pressing a voice chooses it for the next one without playing it.</p>}
      <p className="sset-note">
        Through {info.name}
        {info.model ? ` · ${short(info.model)}` : ""} · {priceLabel(info.perChar)}. It also reads replies aloud — the
        engine and its model are chosen under{" "}
        <button className="textlink" onClick={() => open("listening", "listening.voice")}>
          Listening
        </button>
        .
      </p>
    </>
  );
}

/* ---------------------------------------------------------------- hearing -- */

const EARS: { id: HearEngineId; name: string; blurb: string }[] = [
  { id: "groq", name: "Groq", blurb: "Whisper on Groq — the fastest there is, and free on Groq's own tier." },
  { id: "openrouter", name: "OpenRouter", blurb: "Whisper and newer models through the key chat uses — fractions of a cent an hour." },
  { id: "custom", name: "OpenAI-compatible server", blurb: "Whatever your server's /audio/transcriptions runs." },
  { id: "browser", name: "This browser", blurb: "The browser's own recognition. Free, no key, shows your words as you say them." }
];

function Hearing() {
  const { open } = useSettings();
  const t = store.settings().talk;
  const now = chooseEars();
  const inUse = t.ears || now.id;
  const hosted = inUse && inUse !== "browser" ? inUse : null;
  const hear = hosted ? AI.BACKENDS[hosted].hear : undefined;

  return (
    <>
      <div className="list setlist">
        <button className={"item" + (!t.ears ? " on" : "")} onClick={() => update({ ears: "" })}>
          <span className="grow">
            <span className="t">Automatic</span>
            <span className="s">
              The fastest engine with a key saved — Groq, then OpenRouter — otherwise this browser's own.
              {now.id && !t.ears ? ` Right now: ${earsLabel(now.id)}.` : ""}
            </span>
          </span>
          <span className="state">{!t.ears ? "in use" : ""}</span>
        </button>
        {EARS.map((e) => {
          const v = earsVerdict(e.id);
          const on = t.ears === e.id;
          return (
            <button
              key={e.id}
              className={"item" + (on ? " on" : "")}
              disabled={!on && !v.can}
              title={v.why}
              onClick={() => update({ ears: e.id })}
            >
              <span className="grow">
                <span className="t">{e.name}</span>
                <span className="s">{v.can ? e.blurb : v.why}</span>
              </span>
              <span className="state">{on ? (now.id === e.id ? "in use" : "unavailable") : ""}</span>
            </button>
          );
        })}
      </div>

      {now.fellBack && <p className="sset-note warn">{now.fellBack} Hearing with {now.id ? earsLabel(now.id) : "nothing"} until then.</p>}
      {!now.id && (
        <p className="sset-note warn">
          Nothing here can hear you yet. Add a Groq or OpenRouter key under{" "}
          <button className="textlink" onClick={() => open("connection", "connection.provider")}>
            Connection
          </button>
          , or use a browser with speech recognition of its own.
        </p>
      )}

      {hosted &&
        hear &&
        (hosted === "custom" ? (
          <TextRow
            title="Transcription model"
            sub="Whatever model id your server expects."
            value={t.hearModels.custom || ""}
            placeholder={hear.defaultModel}
            mono
            onCommit={(v) => update({ hearModels: { ...t.hearModels, custom: v.trim() } })}
          />
        ) : (
          <SelectRow
            title="Transcription model"
            sub="Turbo models answer fastest; the rest trade a little speed for accuracy on hard words."
            value={t.hearModels[hosted] || hear.defaultModel}
            options={hear.models.map((m) => ({ value: m, label: short(m) }))}
            onChange={(v) => update({ hearModels: { ...t.hearModels, [hosted]: v } })}
          />
        ))}

      <SelectRow
        title="Language you speak"
        sub="Automatic works it out each time. Naming it makes short replies like “yes, go on” far more reliable."
        value={t.lang}
        placeholder="Automatic"
        options={TALK_LANGS.map((l) => ({ value: l.id, label: l.name }))}
        onChange={(v) => update({ lang: v })}
      />

      <p className="sset-note">
        What you say is sent to be written down: to Groq, OpenRouter or your server with a hosted engine; with the
        browser's own, to whoever makes the browser unless it runs on the device. Nothing is recorded outside a call or
        the check above.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ turns -- */

const PAUSES: { id: TalkSensitivity; label: string; sub: string }[] = [
  { id: "quick", label: "Quick", sub: "For short back-and-forth." },
  { id: "balanced", label: "Balanced", sub: "Waits longer when you trail off on an “and”." },
  { id: "patient", label: "Patient", sub: "Time to think mid-sentence." }
];

function Turns() {
  const t = store.settings().talk;
  return (
    <>
      <div className="vopts three" role="radiogroup" aria-label="Pauses">
        {PAUSES.map((p) => {
          const on = t.sensitivity === p.id;
          const tm = TIMING[p.id];
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={"vopt" + (on ? " on" : "")}
              onClick={() => update({ sensitivity: p.id })}
            >
              <span className="vopt-t">{p.label}</span>
              <span className="vopt-s">{p.sub}</span>
              {/* Read from the table the call runs on, so the numbers here
                  cannot drift from the pauses it actually waits. */}
              <span className="vopt-m">
                answers after {secs(tm.complete)} · {secs(tm.incomplete)} after “and…”
              </span>
            </button>
          );
        })}
      </div>

      <SwitchRow
        title="Interrupt by talking"
        sub="Speaking over a reply stops it and listens. Off, only a tap on the orb or a key does — better in a noisy room."
        on={t.bargeIn}
        onToggle={() => update({ bargeIn: !t.bargeIn })}
      />

      <div className="vkeys" aria-label="Keys during a call">
        <span>
          <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>V</kbd> start or end
        </span>
        <span>
          hold <kbd>Space</kbd> keep the floor
        </span>
        <span>
          <kbd>M</kbd> mute
        </span>
        <span>
          <kbd>Esc</kbd> leave full screen, then end
        </span>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- replies -- */

const STYLES: { id: VoiceStyle; label: string; sub: string }[] = [
  { id: "talk", label: "Talk", sub: "Short spoken answers, like a person across a table. Nothing is put on screen." },
  { id: "show", label: "Show", sub: "Talks, and may put code, a figure or a table in the chat — then tells you where to look." }
];

function Replies() {
  const t = store.settings().talk;
  return (
    <>
      <div className="vopts" role="radiogroup" aria-label="Replies">
        {STYLES.map((s) => {
          const on = t.style === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={"vopt" + (on ? " on" : "")}
              onClick={() => update({ style: s.id })}
            >
              <span className="vopt-t">{s.label}</span>
              <span className="vopt-s">{s.sub}</span>
            </button>
          );
        })}
      </div>
      <p className="sset-note">Where a new call starts. A conversation remembers its own, and the bar switches it mid-call.</p>

      <ModelPicker
        title="Model for voice replies"
        sub="Every spoken answer waits on its first word, so a fast model makes a noticeably quicker conversation."
        value={t.model}
        placeholder="Same as the conversation"
        onChange={(v) => update({ model: v.trim() })}
      />
      {t.model && (
        <p className="sset-note">
          <button className="textlink" onClick={() => update({ model: "" })}>
            Follow each conversation's model again
          </button>
        </p>
      )}

      <p className="sset-note">
        There is no mode to pick in voice. Each question decides for itself whether it needs a plain answer, a look
        through your record, a web search or a plan — and the bar says which it chose.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------- page -- */

export default function Voice() {
  useDrillStore();
  useStoreSync(voices);
  const [, bump] = useState(0);

  /* The hosted voices are listed from the speech catalogue, which Listening
     loads when it opens. This page may be the first to ask. */
  useEffect(() => {
    let alive = true;
    void loadSpeechCatalogue().then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <Section id="voice.check">
        <Check />
      </Section>
      <Section id="voice.voice">
        <Voices />
      </Section>
      <Section id="voice.hearing">
        <Hearing />
      </Section>
      <Section id="voice.turns">
        <Turns />
      </Section>
      <Section id="voice.replies">
        <Replies />
      </Section>
    </>
  );
}
