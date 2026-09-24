/* ============================================================================
 * VoiceControls — what the voice bar and the full-screen view share.
 *
 * Both surfaces read the one session (services/voice) and say the same
 * things about it, so the words and the buttons live here once: what the
 * call is doing, in a line; what is being said, in another; and the handful
 * of controls a conversation needs — mute, hold the floor, talk or show, end.
 *
 * There is no mode picker, no model chip and no Think switch here, on
 * purpose. In voice the reply decides for itself whether a question needs a
 * lookup, a plan or neither (services/agent/prompt.ts), and the status line
 * says which it chose. Asking someone mid-sentence how hard their question is
 * was the confusion this replaced.
 * ========================================================================== */
import { useSyncExternalStore } from "react";
import { voice, type VoiceState } from "@/services/voice";
import type { VoiceStyle } from "@/types";
import Icon from "@/components/ui/Icon";

export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, voice.get, voice.get);
}

/** What the call is doing, in a few words. */
export function statusLine(st: VoiceState): string {
  switch (st.phase) {
    case "starting":
      return "Starting…";
    case "listening":
      if (st.muted) return "Muted — unmute to talk";
      return st.locked ? "Holding — take your time" : "Listening";
    case "hearing":
      return st.locked ? "Holding — let go when you're done" : "Hearing you";
    case "thinking":
      return st.status || "Thinking";
    case "speaking":
      if (st.status) return st.status;
      return st.duplex === "full" ? "Speaking — just talk to interrupt" : "Speaking — tap to interrupt";
    case "error":
      return "Voice stopped";
    default:
      return "";
  }
}

/** The second line: your words while you speak and while it thinks, its own
 *  sentence while it talks, and anything worth saying about either. */
export function captionLine(st: VoiceState): { text: string; kind: "you" | "it" | "note" | "" } {
  if (st.phase === "error") return { text: st.error || "", kind: "note" };
  if (st.notice && (st.phase === "listening" || st.phase === "speaking")) return { text: st.notice, kind: "note" };
  if (st.phase === "speaking" && st.saying) return { text: st.saying, kind: "it" };
  if ((st.phase === "hearing" || st.phase === "thinking") && st.caption) return { text: st.caption, kind: "you" };
  if (st.phase === "thinking" && st.saying) return { text: st.saying, kind: "it" };
  return { text: "", kind: "" };
}

export function StyleSwitch({ st, onStyle }: { st: VoiceState; onStyle: (s: VoiceStyle) => void }) {
  return (
    <div className="vb-seg" role="radiogroup" aria-label="How replies are shaped">
      {(
        [
          ["talk", "Talk", "Only words — short, spoken answers. Nothing is put on screen."],
          ["show", "Show", "Talks, and may put code, figures or tables on screen, saying what to look at."]
        ] as const
      ).map(([id, label, title]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={st.style === id}
          className={"vb-segbtn" + (st.style === id ? " on" : "")}
          title={title}
          onClick={() => onStyle(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function VoiceButtons({
  st,
  expanded,
  onExpand,
  onEnd
}: {
  st: VoiceState;
  expanded: boolean;
  onExpand: () => void;
  onEnd: () => void;
}) {
  const live = st.phase !== "error" && st.phase !== "starting";
  return (
    <>
      <button
        type="button"
        className={"ctool ctool-icon" + (st.muted ? " set" : "")}
        onClick={() => voice.setMuted(!st.muted)}
        disabled={!live}
        aria-pressed={st.muted}
        aria-label={st.muted ? "Unmute the microphone" : "Mute the microphone"}
        title={st.muted ? "Unmute  (M)" : "Mute  (M)"}
      >
        <Icon name={st.muted ? "mic-off" : "mic"} size={17} />
      </button>
      {/* Held, not toggled: the floor is yours for exactly as long as you
          hold it, and letting go is what says you are done. Space does the
          same from the keyboard. */}
      <button
        type="button"
        className={"ctool ctool-icon" + (st.locked ? " on" : "")}
        disabled={!live || st.muted}
        aria-pressed={st.locked}
        aria-label="Hold to keep talking through pauses"
        title="Hold to keep the floor through pauses — let go when you're done  (hold Space)"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
          if (st.phase === "speaking" || st.phase === "thinking") voice.interrupt();
          voice.setLocked(true);
        }}
        onPointerUp={() => voice.setLocked(false)}
        onPointerCancel={() => voice.setLocked(false)}
      >
        <Icon name="lock" size={16} />
      </button>
      <button
        type="button"
        className="ctool ctool-icon"
        onClick={onExpand}
        aria-label={expanded ? "Back to the conversation" : "Full screen"}
        title={expanded ? "Back to the conversation" : "Full screen"}
      >
        <Icon name={expanded ? "collapse" : "expand"} size={15} />
      </button>
      <button type="button" className="vb-end" onClick={onEnd} aria-label="End voice" title="End voice  (Esc)">
        <Icon name="close" size={16} />
      </button>
    </>
  );
}
