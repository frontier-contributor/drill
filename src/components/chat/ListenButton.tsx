/* ============================================================================
 * ListenButton — hear this reply, from the row of things you can do with it.
 *
 * A split button, the same shape as Regenerate beside it: the speaker plays and
 * pauses, the caret opens the voice and the speed. It never plays anything on
 * its own — the point of it is that reading a long reply aloud is a choice,
 * made when it is wanted.
 *
 * It asks services/speech/choice what would read, and is simply absent when
 * the answer is nothing: a button that can only fail is worse than none. The
 * tooltip gives the price before the click, because a hosted voice bills by
 * the character and "what will this cost" is a question for before.
 *
 * The engine is created inside the click, never after something is awaited.
 * Safari only lets audio start from within a user gesture, and the hosted
 * engine spends the gesture on a moment of silence so the real audio, a
 * second later, is allowed to play.
 * ========================================================================== */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as store from "@/services/store";
import * as voices from "@/services/speech/voices";
import { player, type ListenSource } from "@/services/speech/player";
import { SPEEDS, estimate, listen, priceLabel, resolveChoice, revoice, setVoice, speedLabel } from "@/services/speech/choice";
import { loadSpeechCatalogue } from "@/services/pricing";
import { segmentReply, sentenceAtSelection } from "@/lib/speech/segment";
import { markdownToText } from "@/lib/plaintext";
import { formatCost } from "@/lib/tokens";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useSettings } from "@/context/SettingsContext";
import { useToast } from "@/context/ToastContext";
import type { Conversation, Turn } from "@/types/chat";
import Icon, { type IconName } from "../ui/Icon";

export default function ListenButton({
  turn,
  conversation,
  content,
  root
}: {
  turn: Turn;
  conversation: Conversation;
  /** The reply's markdown, for the character count in the tooltip. */
  content: string;
  /** The rendered reply — what is actually read. */
  root: RefObject<Element | null>;
}) {
  useDrillStore();
  useStoreSync(player);
  useStoreSync(voices);
  const settings = useSettings();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  /* The tooltip's price needs the speech catalogue, fetched once and cached
     for a day. Without a re-render when it lands, the first tooltip of every
     visit would say "price unknown" for a price one request away. */
  const [, bump] = useState(0);
  useEffect(() => {
    let live = true;
    void loadSpeechCatalogue().then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    /* Escape closes this and nothing else — without stopPropagation the same
       keypress reaches the composer and clears the message being written. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const chars = useMemo(() => markdownToText(content).length, [content]);

  const choice = resolveChoice();
  const st = player.get();
  const src = st.source;
  const mine =
    st.status !== "idle" && !!src && src.conversationId === conversation.id && src.turnId === turn.id && src.variant === turn.active;

  if (!choice && !mine) return null;

  function start() {
    const el = root.current;
    if (!el) return;
    const sentences = segmentReply(el);
    if (!sentences.length) {
      toast("Nothing in this reply to read aloud");
      return;
    }
    const source: ListenSource = {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      turnId: turn.id,
      variant: turn.active,
      title: conversation.title,
      sentences: sentences.map((s) => s.spoken)
    };
    if (!listen(source, sentenceAtSelection(sentences, el))) toast("Nothing here can read aloud — see Settings → Listening");
  }

  function main() {
    if (!mine) return start();
    if (st.status === "playing" || st.status === "loading") player.pause();
    else player.resume();
  }

  function speed(rate: number) {
    store.updateSettings({ speech: { ...store.settings().speech, rate } });
    player.setRate(rate);
  }

  function voice(v: string) {
    if (!choice) return;
    setVoice(choice.info.id, { voice: v });
    revoice();
  }

  const status = mine ? st.status : "idle";
  const [icon, word]: [IconName, string] =
    status === "loading"
      ? ["speaker", "Preparing…"]
      : status === "playing"
        ? ["pause", "Pause"]
        : status === "paused"
          ? ["play", "Resume"]
          : status === "error"
            ? ["refresh", "Retry"]
            : ["speaker", "Listen"];
  const sounding = status === "playing" || status === "loading";

  const cost = choice ? estimate(choice.info, chars) : undefined;
  const title =
    status === "error"
      ? `${st.error || "The voice stopped."} Click to retry.`
      : sounding
        ? "Pause reading"
        : status === "paused"
          ? "Resume reading"
          : !choice
            ? "Listen"
            : choice.info.perChar === 0
              ? `Listen — ${choice.label}, free`
              : `Listen — about ${chars.toLocaleString()} characters, ${cost == null ? "price unknown" : "≈ " + formatCost(cost)}, with ${choice.label}`;
  const rate = store.settings().speech.rate;

  return (
    <div className="regenmenu listenmenu" ref={boxRef}>
      {/* Icon only, like the star and delete at the other end of the row. With
          a label the row came out 29px wider than the reading column and wrapped
          under every reply; the tooltip carries the words and the price, and the
          bar that opens on the first click says the rest. */}
      <button
        className={"tact regenmenu-main" + (sounding ? " playing" : "")}
        onClick={main}
        title={title}
        aria-label={word}
        aria-pressed={sounding}
        aria-busy={status === "loading" || undefined}
      >
        <Icon name={icon} size={14} />
      </button>
      <button
        className="tact regenmenu-caret"
        onClick={() => setOpen((v) => !v)}
        title="Voice and speed"
        aria-label="Voice and speed"
        aria-expanded={open}
      >
        <Icon name="chevron" size={10} />
      </button>

      {open && (
        <div className="modelpop listenpop" role="dialog" aria-label="Voice and speed">
          <div className="modelpop-head">
            <span>Read aloud</span>
            <button
              className="modelpop-clear"
              onClick={() => {
                setOpen(false);
                settings.open("listening", "listening.voice");
              }}
            >
              all settings
            </button>
          </div>

          {choice ? (
            <>
              <div className="listenpop-voice">
                <span className="t">{choice.label}</span>
                <span className="s">{priceLabel(choice.info.perChar)}</span>
              </div>
              {choice.fellBack && <p className="listenpop-note">{choice.fellBack}</p>}
              {choice.info.voices.length > 1 && (
                <select className="fi" value={choice.info.voice} onChange={(e) => voice(e.target.value)} aria-label="Voice">
                  {choice.info.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <p className="listenpop-note">Nothing here can read aloud any more.</p>
          )}

          <div className="listenpop-label">Speed</div>
          <div className="tools-seg" role="radiogroup" aria-label="Speed">
            {SPEEDS.map((r) => (
              <button
                key={r}
                className={"tools-segbtn" + (rate === r ? " on" : "")}
                role="radio"
                aria-checked={rate === r}
                onClick={() => speed(r)}
              >
                {speedLabel(r)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
