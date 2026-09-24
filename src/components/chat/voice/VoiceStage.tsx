/* ============================================================================
 * VoiceStage — the call, full screen.
 *
 * For when you are walking around the room and the thread is noise: the orb
 * at a size you can see from across a desk, one line of what it is doing,
 * one of what is being said, and the controls. It covers the chat column
 * only — the sidebar and the rest of the app stay where they are.
 *
 * What it cannot show is a code block or a figure a reply put on screen, so
 * when a reply does that, it says so and offers the way back to the thread.
 * ========================================================================== */
import { useEffect, useState } from "react";
import { voice } from "@/services/voice";
import type { VoiceStyle } from "@/types";
import VoiceOrb from "./VoiceOrb";
import { StyleSwitch, VoiceButtons, captionLine, statusLine, useVoice } from "./VoiceControls";
import "@/styles/voice.css";

/** The orb's size, measured against the window it is in. */
function orbSize(): number {
  if (typeof window === "undefined") return 240;
  return Math.round(Math.max(150, Math.min(300, window.innerHeight * 0.36, window.innerWidth * 0.62)));
}

export default function VoiceStage({ onCollapse, onStyle }: { onCollapse: () => void; onStyle: (s: VoiceStyle) => void }) {
  const st = useVoice();
  const cap = captionLine(st);
  const talking = st.phase === "speaking" || st.phase === "thinking";
  const [size, setSize] = useState(orbSize);

  useEffect(() => {
    const onResize = () => setSize(orbSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div className={"voice-stage ph-" + st.phase} role="dialog" aria-label="Voice conversation">
      <div className="vs-center">
        <button
          type="button"
          className="vs-orb"
          onClick={() => (talking ? voice.interrupt() : voice.setMuted(!st.muted))}
          aria-label={talking ? "Stop and listen" : st.muted ? "Unmute" : "Mute"}
        >
          <VoiceOrb size={size} />
        </button>
        <div className="vs-status" aria-live="polite">
          {statusLine(st)}
        </div>
        <div className={"vs-caption " + cap.kind}>{cap.text}</div>
        {st.onScreen && (
          <button type="button" className="vs-shown" onClick={onCollapse}>
            There's something on screen for this one — show the conversation
          </button>
        )}
      </div>

      <div className="vs-controls">
        <StyleSwitch st={st} onStyle={onStyle} />
        <VoiceButtons st={st} expanded onExpand={onCollapse} onEnd={() => voice.stop()} />
      </div>
      <p className="vs-foot">
        {st.earsLabel && st.voiceLabel ? `Hearing with ${st.earsLabel} · speaking with ${st.voiceLabel}` : ""}
      </p>
    </div>
  );
}
