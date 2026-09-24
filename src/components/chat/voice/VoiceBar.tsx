/* ============================================================================
 * VoiceBar — the composer, while you are talking instead of typing.
 *
 * It takes the composer's place and its shape — one box at the foot of the
 * thread — so starting a call changes what the box does, not where anything
 * is. The thread above stays live: what you said and what it answered land
 * there as they happen, and in Show a block of code or a figure appears in
 * it while the voice says to look.
 *
 * The orb is the one big control. Tapped while it talks, it stops talking and
 * listens; the same as saying something, for the times saying something is
 * not an option. Everything the bar says comes from VoiceControls, which the
 * full-screen view shares.
 * ========================================================================== */
import { voice } from "@/services/voice";
import type { VoiceStyle } from "@/types";
import VoiceOrb from "./VoiceOrb";
import { StyleSwitch, VoiceButtons, captionLine, statusLine, useVoice } from "./VoiceControls";
import "@/styles/voice.css";

export default function VoiceBar({
  expanded,
  onExpand,
  onStyle
}: {
  expanded: boolean;
  onExpand: () => void;
  onStyle: (s: VoiceStyle) => void;
}) {
  const st = useVoice();
  const cap = captionLine(st);
  const talking = st.phase === "speaking" || st.phase === "thinking";

  return (
    <div className="composer voicebar-host">
      <div className="composer-inner">
        <div className={"voicebar ph-" + st.phase} role="group" aria-label="Voice conversation">
          <button
            type="button"
            className="vb-orb"
            onClick={() => (talking ? voice.interrupt() : voice.setMuted(!st.muted))}
            aria-label={talking ? "Stop and listen" : st.muted ? "Unmute" : "Mute"}
            title={talking ? "Stop and listen" : st.muted ? "Unmute" : "Mute"}
          >
            <VoiceOrb size={52} />
          </button>

          <div className="vb-text" aria-live="polite">
            <div className="vb-status">{statusLine(st)}</div>
            {cap.text && <div className={"vb-caption " + cap.kind}>{cap.text}</div>}
          </div>

          <div className="vb-tools">
            <StyleSwitch st={st} onStyle={onStyle} />
            <VoiceButtons st={st} expanded={expanded} onExpand={onExpand} onEnd={() => voice.stop()} />
          </div>
        </div>
      </div>
    </div>
  );
}
