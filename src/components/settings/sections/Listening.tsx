/* ============================================================================
 * Listening — which voice reads replies aloud, how fast, and what it keeps.
 *
 * Every engine is listed, and one that cannot speak from here says why in its
 * own row instead of vanishing: a hosted voice that needs a key should point
 * at the Connection page, not leave you wondering whether the app has voices
 * at all. The pickers under the list only ever hold what the chosen engine
 * can use — its speech models, and that model's own voices — so nothing on
 * this page can be set to something a provider would refuse.
 *
 * Automatic is a row of its own rather than a default hidden behind the first
 * engine, because it is a different promise: the best voice this browser can
 * reach, which changes the moment a key is added.
 *
 * The voice chosen here is also the one that answers in voice mode. Everything
 * else about talking — the microphone, turn-taking, reply style — is on the
 * Voice page, which shows this same voice as tiles you can press and hear.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as store from "@/services/store";
import * as voices from "@/services/speech/voices";
import * as cache from "@/services/speech/cache";
import { player } from "@/services/speech/player";
import {
  ENGINE_ORDER,
  SAMPLE_TURN,
  SPEEDS,
  engineInfo,
  playSample,
  priceLabel,
  resolveChoice,
  revoice,
  setVoice,
  speedLabel,
  type EngineInfo
} from "@/services/speech/choice";
import { loadSpeechCatalogue } from "@/services/pricing";
import { fmtBytes } from "@/lib/util";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useSettings } from "@/context/SettingsContext";
import SelectRow from "../../ui/SelectRow";
import SwitchRow from "../../ui/SwitchRow";
import TextRow from "../../ui/TextRow";
import Section from "../Section";
import type { SpeechSettings } from "@/types";

const CAPS: SpeechSettings["cacheMB"][] = [0, 25, 100];

function update(patch: Partial<SpeechSettings>): void {
  store.updateSettings({ speech: { ...store.settings().speech, ...patch } });
}

function summary(info: EngineInfo): string {
  if (info.id === "device") {
    return `${info.voices.length} ${info.voices.length === 1 ? "voice" : "voices"} in this browser · free · works offline`;
  }
  return `${info.model.split("/").pop()} · ${info.voice} · ${priceLabel(info.perChar)}`;
}

function Pickers({ info }: { info: EngineInfo }) {
  const pick = (patch: { model?: string; voice?: string }) => {
    setVoice(info.id, patch);
    revoice();
  };

  if (info.id === "device") {
    if (!info.voices.length) return null;
    return (
      <SelectRow
        title="Voice"
        sub="Voices marked “online” are streamed by the browser and usually sound best; the rest also work offline."
        value={info.voice}
        options={info.voices.map((v) => ({ value: v.id, label: v.label }))}
        onChange={(v) => pick({ voice: v })}
      />
    );
  }

  if (info.source === "typed") {
    return (
      <>
        <TextRow
          title="Speech model"
          sub="Whatever your server calls it. OpenAI's own are tts-1 and gpt-4o-mini-tts."
          value={info.model}
          mono
          onCommit={(v) => pick({ model: v.trim() })}
        />
        <TextRow title="Voice" value={info.voice} mono onCommit={(v) => pick({ voice: v.trim() })} />
      </>
    );
  }

  return (
    <>
      <SelectRow
        title="Speech model"
        sub={
          info.source === "catalogue"
            ? "Only models that publish their voices and price by the character are listed, cheapest first."
            : "The speech models this provider documents."
        }
        value={info.model}
        options={info.models.map((m) => ({ value: m.id, label: m.label }))}
        onChange={(m) => pick({ model: m })}
      />
      {info.voices.length > 0 && (
        <SelectRow
          title="Voice"
          sub="The voices this model has. Switching model picks its default voice."
          value={info.voice}
          options={info.voices.map((v) => ({ value: v.id, label: v.label }))}
          onChange={(v) => pick({ voice: v })}
        />
      )}
    </>
  );
}

export default function Listening() {
  useDrillStore();
  useStoreSync(voices);
  useStoreSync(cache);
  useStoreSync(player);
  const { open } = useSettings();
  const [, bump] = useState(0);
  const [kept, setKept] = useState<{ bytes: number; clips: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const cacheVersion = cache.getVersion();

  useEffect(() => {
    let live = true;
    void loadSpeechCatalogue().then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void cache.stats().then((s) => live && setKept(s));
    return () => {
      live = false;
    };
  }, [cacheVersion]);

  const s = store.settings().speech;
  const choice = resolveChoice();
  const selected = s.engine ? engineInfo(s.engine) : (choice?.info ?? null);
  const st = player.get();
  const sampling = st.status !== "idle" && st.source?.turnId === SAMPLE_TURN;
  const problem = cache.lastProblem();

  return (
    <>
      <Section id="listening.voice">
        <div className="list setlist">
          <button className={"item" + (!s.engine ? " on" : "")} onClick={() => update({ engine: "" })}>
            <span className="grow">
              <span className="t">Automatic</span>
              <span className="s">
                OpenRouter's voice when a key for it is saved, otherwise this device's.
                {choice && !s.engine ? ` Right now: ${choice.label}.` : ""}
              </span>
            </span>
            <span className="state">{!s.engine ? "in use" : ""}</span>
          </button>
          {ENGINE_ORDER.map((id) => {
            const info = engineInfo(id);
            const on = s.engine === id;
            return (
              <button
                key={id}
                className={"item" + (on ? " on" : "")}
                disabled={!on && !info.verdict.can}
                title={info.verdict.why}
                onClick={() => update({ engine: id })}
              >
                <span className="grow">
                  <span className="t">{info.name}</span>
                  <span className="s">{info.verdict.can ? summary(info) : info.verdict.why}</span>
                </span>
                <span className="state">{on ? (choice?.info.id === id ? "in use" : "unavailable") : ""}</span>
              </button>
            );
          })}
        </div>

        {choice?.fellBack && (
          <p className="sset-note warn">
            {choice.fellBack} Reading with {choice.label} until then.
          </p>
        )}
        {!choice && (
          <p className="sset-note warn">
            Nothing in this browser can read aloud yet. Add an OpenRouter key under{" "}
            <button className="textlink" onClick={() => open("connection", "connection.provider")}>
              Connection
            </button>
            , or install a voice on this device.
          </p>
        )}

        {selected && (selected.verdict.can || selected.models.length > 0) && <Pickers info={selected} />}

        <div className="btnrow">
          <button className="btn sm" disabled={!choice && !sampling} onClick={() => (sampling ? player.stop() : playSample())}>
            {sampling ? "Stop the sample" : "Hear a sample"}
          </button>
        </div>
        <p className="sset-note">
          A hosted voice is paid for by the character, and every request is on the{" "}
          <button className="textlink" onClick={() => open("usage", "usage.cost")}>
            Usage page
          </button>{" "}
          under “listen”. This device's own voice costs nothing and never leaves the browser.
        </p>
      </Section>

      <Section id="listening.playback">
        <div className="srow">
          <span className="grow">
            <span className="t">Speed</span>
            <span className="s">Also a click away on the bar while something is playing. Hosted voices keep their pitch at any speed.</span>
          </span>
        </div>
        <div className="seg">
          {SPEEDS.map((r) => (
            <button
              key={r}
              className={s.rate === r ? "on" : ""}
              onClick={() => {
                update({ rate: r });
                player.setRate(r);
              }}
            >
              {speedLabel(r)}
            </button>
          ))}
        </div>
        <SwitchRow
          title="Follow along"
          sub="Highlight the sentence being read and keep it on screen. Scrolling yourself stops the following until you ask for it back."
          on={s.follow}
          onToggle={() => update({ follow: !s.follow })}
        />
      </Section>

      <Section id="listening.audio">
        <div className="seg">
          {CAPS.map((mb) => (
            <button
              key={mb}
              className={s.cacheMB === mb ? "on" : ""}
              onClick={() => {
                update({ cacheMB: mb });
                void cache.trimTo(mb);
              }}
            >
              {mb === 0 ? "Keep none" : `Up to ${mb} MB`}
            </button>
          ))}
        </div>
        <p className="sset-note">
          {kept ? (kept.clips ? `${fmtBytes(kept.bytes)} kept, in ${kept.clips} ${kept.clips === 1 ? "clip" : "clips"}. ` : "Nothing kept yet. ") : ""}
          Kept in a database of its own, never in a backup, dropped after thirty days unplayed, and never written while this
          browser's storage is nearly full.
        </p>
        {problem && <p className="sset-note warn">{problem}</p>}
        <div className="btnrow">
          {confirming ? (
            <>
              <button
                className="btn sm danger"
                onClick={() => {
                  void cache.clear();
                  setConfirming(false);
                }}
              >
                Delete saved audio
              </button>
              <button className="btn sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn sm" disabled={!kept?.clips} onClick={() => setConfirming(true)}>
              Clear saved audio
            </button>
          )}
        </div>
      </Section>
    </>
  );
}
