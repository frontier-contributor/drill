/* ============================================================================
 * ThinkingPanel — the model's working, live and afterwards.
 *
 * One component for two jobs, on AgentTrace's argument: the chain arriving and
 * the chain as kept are the same picture at different times, and rendering
 * them separately is how they drift.
 *
 * The honest-animation rule this thing exists to obey: **it never names a
 * stage it cannot see.** Perplexity can say "Searching" because Perplexity is
 * the one searching. What arrives here is an opaque token stream from someone
 * else's model, so the only true things to show are the working itself (when
 * the provider sends it) and how long it has been going (always). A cycling
 * "Analysing… Cross-referencing… Synthesising…" would be the app inventing an
 * account of a process it has no visibility into, and the first time a user
 * noticed it was fiction, every other receipt in this app would be worth less.
 *
 * So: real chain if there is one, a counting shimmer if there is not, and in
 * both cases the elapsed time — which is a fact.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import { thinkingLabel, thoughtLabel } from "@/lib/reasoning";

export default function ThinkingPanel({
  text,
  running,
  since,
  ms,
  tokens,
  compact
}: {
  /** The chain, live or saved. "" is the third state: it thought and the
   *  provider did not send the working. */
  text: string;
  /** In flight — open, counting, and not collapsible. */
  running?: boolean;
  /** When the request went out. Read only while running. */
  since?: number;
  /** How long it thought, once that is known. */
  ms?: number;
  /** Reasoning tokens billed, when the provider reported them. */
  tokens?: number;
  /** Inside an agent step, where the surrounding trace already supplies the
   *  rule and the indent. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scroller = useRef<HTMLDivElement | null>(null);
  /* Whether the reader is following the stream or has scrolled back to read
     something. Auto-scrolling regardless is the behaviour that makes a live
     log impossible to read — the one thing you want to do while it streams is
     stop and look at a line, and the panel would yank you away from it. */
  const following = useRef(true);

  /* The counter. One second is the right granularity for a number a person
     glances at, and it is also the floor a background tab clamps timers to —
     a faster tick would not survive the tab being hidden anyway. */
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !following.current) return;
    /* "auto", never "smooth": a smooth scroll retargeted on every chunk never
       arrives, and it is silently dropped in a hidden tab besides. */
    el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!text && !running && ms == null) return null;

  const shown = running || open;
  const label = running ? thinkingLabel(Math.max(0, now - (since ?? now))) : thoughtLabel(ms, tokens);
  /* It thought and will not show you the working. Said plainly rather than
     dressed up: a claim about what a model did that the user cannot check is
     exactly the kind of thing that has to admit it is unverifiable. */
  const opaque = !text && !running;

  return (
    <div className={"think" + (running ? " live" : "") + (compact ? " compact" : "")}>
      <button
        className="think-toggle"
        onClick={() => !running && text && setOpen((v) => !v)}
        aria-expanded={shown}
        disabled={running || !text}
        title={opaque ? "This model reasons before answering but does not publish the working." : undefined}
      >
        <Icon name="brain" size={12} />
        <span className={"think-label" + (running ? " shimmer" : "")}>{label}</span>
        {opaque && <span className="think-hidden">working not shown</span>}
        {!running && !!text && <Icon name="chevron" size={11} className={"think-chev" + (shown ? " on" : "")} />}
      </button>

      {/* A grid that animates from 0fr to 1fr, which is how a panel of unknown
          height opens without anyone measuring it in JavaScript. */}
      <div className={"think-wrap" + (shown && text ? " on" : "")}>
        <div className="think-clip">
          <div
            className="think-body"
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
            }}
          >
            {/* Pre-wrap rather than markdown on purpose. This is a scratchpad,
                not prose: it is full of half-written fences and broken lists,
                and running it through the renderer would produce a mangled
                document that looks like the model made a mess. It is also the
                cheap answer to safety — nothing here is ever parsed as HTML. */}
            <p className="think-text">{text}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
