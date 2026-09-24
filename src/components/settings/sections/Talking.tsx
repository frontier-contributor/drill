/* ============================================================================
 * Talking — voice conversations: what hears you, and how patiently.
 *
 * The voice that answers is the one chosen above on this page — Listening
 * and Talking share it on purpose, so there is one answer to "what does the
 * app sound like". What is decided here is the other half: which engine turns
 * your speech into words, how long a pause is before it counts as the end of
 * what you said, whether talking over a reply stops it, and how replies are
 * shaped for being heard.
 *
 * Every engine is listed, and one that cannot hear from here says why in its
 * own row, the way the voices above do.
 * ========================================================================== */
import * as store from "@/services/store";
import * as AI from "@/services/ai";
import { chooseEars, earsLabel, earsVerdict } from "@/services/voice/ears";
import { useSettings } from "@/context/SettingsContext";
import SelectRow from "../../ui/SelectRow";
import SwitchRow from "../../ui/SwitchRow";
import TextRow from "../../ui/TextRow";
import Section from "../Section";
import type { HearEngineId, TalkSettings, TalkSensitivity, VoiceStyle } from "@/types";

const EARS: { id: HearEngineId; name: string; blurb: string }[] = [
  { id: "groq", name: "Groq", blurb: "Whisper on Groq — the fastest there is, and free on Groq's own tier." },
  { id: "openrouter", name: "OpenRouter", blurb: "Whisper and newer models through the key chat uses — fractions of a cent an hour." },
  { id: "custom", name: "OpenAI-compatible server", blurb: "Whatever your server's /audio/transcriptions runs." },
  { id: "browser", name: "This browser", blurb: "The browser's own recognition. Free, no key, shows your words as you say them." }
];

const PAUSES: { id: TalkSensitivity; label: string; sub: string }[] = [
  { id: "quick", label: "Quick", sub: "Answers the moment you stop. Best for short back-and-forth." },
  { id: "balanced", label: "Balanced", sub: "Waits a beat, longer when you trail off on an “and”." },
  { id: "patient", label: "Patient", sub: "Gives you time to think mid-sentence. Hold Space for longer still." }
];

function update(patch: Partial<TalkSettings>): void {
  store.updateSettings({ talk: { ...store.settings().talk, ...patch } });
}

export default function Talking() {
  const { open } = useSettings();
  const t = store.settings().talk;
  const now = chooseEars();
  const hosted = (t.ears || now.id) && (t.ears || now.id) !== "browser" ? ((t.ears || now.id) as Exclude<HearEngineId, "browser">) : null;
  const hear = hosted ? AI.BACKENDS[hosted].hear : undefined;

  return (
    <Section id="listening.talking">
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

      {hosted && hear && (hosted === "custom" ? (
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
          options={hear.models.map((m) => ({ value: m, label: m.split("/").pop() || m }))}
          onChange={(v) => update({ hearModels: { ...t.hearModels, [hosted]: v } })}
        />
      ))}

      <div className="srow">
        <span className="grow">
          <span className="t">Pauses</span>
          <span className="s">{PAUSES.find((p) => p.id === t.sensitivity)?.sub}</span>
        </span>
      </div>
      <div className="seg">
        {PAUSES.map((p) => (
          <button key={p.id} className={t.sensitivity === p.id ? "on" : ""} onClick={() => update({ sensitivity: p.id })}>
            {p.label}
          </button>
        ))}
      </div>

      <SwitchRow
        title="Interrupt by talking"
        sub="Speaking over a reply stops it and listens. Off, only a tap on the orb or a key does — better in a noisy room."
        on={t.bargeIn}
        onToggle={() => update({ bargeIn: !t.bargeIn })}
      />

      <div className="srow">
        <span className="grow">
          <span className="t">Replies</span>
          <span className="s">
            {t.style === "talk"
              ? "Talk: short spoken answers, nothing put on screen."
              : "Show: talks, and may put code, figures or tables on screen, saying what to look at."}{" "}
            A conversation remembers its own choice.
          </span>
        </span>
      </div>
      <div className="seg">
        {(["talk", "show"] as VoiceStyle[]).map((s) => (
          <button key={s} className={t.style === s ? "on" : ""} onClick={() => update({ style: s })}>
            {s === "talk" ? "Talk" : "Show"}
          </button>
        ))}
      </div>

      <TextRow
        title="Model for voice replies"
        sub="Empty follows the conversation's own model. A fast model makes a noticeably quicker conversation."
        value={t.model}
        placeholder="Same as the conversation"
        mono
        onCommit={(v) => update({ model: v.trim() })}
      />

      <p className="sset-note">
        Voice decides for itself whether a question needs a lookup in your record, a search, or a plan — there is no
        mode to choose. What hearing you costs is on the{" "}
        <button className="textlink" onClick={() => open("usage", "usage.cost")}>
          Usage page
        </button>{" "}
        under “voice”; what saying the replies costs, under “listen”.
      </p>
    </Section>
  );
}
