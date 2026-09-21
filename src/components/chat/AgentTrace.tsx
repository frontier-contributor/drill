/* ============================================================================
 * AgentTrace — what the assistant did before it answered.
 *
 * One component for two jobs, because they are the same picture at different
 * times: the loop running (from ChatContext's AgentLive) and the loop as
 * recorded (from Variant.trace). Rendering those separately is how they drift,
 * and a live view that does not match the saved one teaches you to distrust
 * both.
 *
 * Collapsed by default once finished. The trace is the audit trail, not the
 * answer — it should be one glance away, never in front of the reply. While
 * the loop is *running* it is open, because then it is the only thing on
 * screen worth looking at.
 * ========================================================================== */
import { useState } from "react";
import Icon from "@/components/ui/Icon";
import ThinkingPanel from "./ThinkingPanel";
import type { AgentPlan, ToolCall, ToolRun } from "@/types/agent";

/** The shape both callers flatten to. Deliberately not `AgentStep`: a live
 *  step has calls that have not returned yet, and a finished one does not. */
export interface TraceStep {
  step: number;
  thought: string;
  calls: ToolCall[];
  runs: ToolRun[];
  /** The model's working on this round, when the provider sent it. Live only
   *  — the saved trace keeps the calls and their results, which is the half
   *  you can actually check an answer against. */
  reasoning?: string;
}

/** A bare tool name reads like an internal. This is the same act said the way
 *  a person would say it, which is what belongs in front of the learner —
 *  the raw name is still there on the row's title attribute. */
const VERB: Record<string, string> = {
  overview: "Checked where this project stands",
  recall: "Searched your record",
  open: "Read one in full",
  reviews: "Read how your reviews went",
  remember: "Saved to memory",
  forget: "Retired a memory",
  draft_card: "Drafted a card",
  journal_add: "Added to your journal",
  plan: "Wrote a plan",
  plan_step: "Closed a step",
  note: "Noted a conclusion"
};

/**
 * What a write tool actually did, which is not always what it set out to do.
 *
 * `remember` under `assisted` autonomy usually *queues* rather than saves,
 * and a row that said "Saved to memory" over a result reading "queued for
 * review — it is not saved yet" would be the app telling the same lie the
 * system prompt spends a paragraph forbidding the model to tell. The label has
 * to follow the outcome.
 */
function verbFor(call: ToolCall, run?: ToolRun): string {
  const base = VERB[call.name] || call.name;
  if (!run) return base;
  if (run.result.proposed?.length) {
    return call.name === "draft_card" ? "Drafted a card for you to accept" : "Proposed a memory for review";
  }
  if (call.name === "remember" && !run.result.ok) return "Tried to save a memory";
  /* `recall` with a source filter is a different act from an open search, and
     the row should say which — "Searched your journal" is checkable against
     the answer in a way that "Searched your record" is not. */
  if (call.name === "recall") {
    const src = call.args?.source;
    if (typeof src === "string" && src && src !== "all") return `Searched your ${src}`;
  }
  return base;
}

/** The one argument worth showing on the row. A full argument dump is noise;
 *  the query is the thing that tells you whether it looked for the *right*
 *  thing, which is the entire point of showing the trace at all.
 *
 *  Strings only. A numeric argument rendered bare — "Read how your reviews
 *  went · 7" — carries no meaning without its parameter name, and printing the
 *  name too would turn the row back into the argument dump this avoids. */
function subject(call: ToolCall): string {
  const a = call.args || {};
  const first = [a.query, a.text, a.q, a.ref, a.goal, a.note].find((v) => typeof v === "string" && v.trim());
  if (typeof first !== "string") return "";
  return first.length > 60 ? first.slice(0, 60) + "…" : first;
}

function Row({ call, run }: { call: ToolCall; run?: ToolRun }) {
  const [open, setOpen] = useState(false);
  const pending = !run;
  const failed = run && !run.result.ok;
  const label = verbFor(call, run);
  const subj = subject(call);

  return (
    <li className={"atrace-row" + (pending ? " pending" : "") + (failed ? " miss" : "")}>
      <button
        className="atrace-head"
        onClick={() => !pending && setOpen((v) => !v)}
        title={call.name + "(" + JSON.stringify(call.args) + ")"}
        aria-expanded={open}
        disabled={pending}
      >
        <span className="atrace-dot" aria-hidden="true" />
        <span className="atrace-label">
          {label}
          {subj && <span className="atrace-subject"> · {subj}</span>}
        </span>
        {pending ? (
          <span className="atrace-time">…</span>
        ) : (
          <>
            <span className="atrace-time">{run!.ms < 1000 ? `${run!.ms}ms` : `${(run!.ms / 1000).toFixed(1)}s`}</span>
            <Icon name="chevron" size={11} className={"atrace-chev" + (open ? " on" : "")} />
          </>
        )}
      </button>
      {/* The raw result, verbatim. This is the whole argument for having a
          trace: you can check that the answer follows from what came back. */}
      {open && run && <pre className="atrace-result">{run.result.text}</pre>}
    </li>
  );
}

/**
 * The plan, which is the part a person actually reads.
 *
 * Rendered above the lookups rather than inside them: the plan is the promise
 * and the lookups are the evidence, and a reader checking whether the answer
 * covered the question wants the promise first. It stays visible when the rest
 * of the trace is collapsed, for the same reason.
 */
function PlanBlock({ plan, running }: { plan: AgentPlan; running?: boolean }) {
  const done = plan.items.filter((i) => i.status === "done" || i.status === "dropped").length;
  return (
    <div className="aplan">
      <p className="aplan-goal">{plan.goal}</p>
      <ol className="aplan-items">
        {plan.items.map((it) => (
          <li key={it.id} className={"aplan-item " + it.status}>
            <span className="aplan-mark" aria-hidden="true">
              {it.status === "done" ? <Icon name="check" size={11} /> : it.status === "dropped" ? "—" : it.status === "doing" ? "›" : ""}
            </span>
            <span className="aplan-text">
              {it.text}
              {it.note && <span className="aplan-note">{it.note}</span>}
            </span>
          </li>
        ))}
      </ol>
      {running && (
        <p className="aplan-progress">
          {done} of {plan.items.length} done
        </p>
      )}
    </div>
  );
}

export default function AgentTrace({
  steps,
  plan,
  notes,
  unfinished,
  running,
  truncated,
  totalMs
}: {
  steps: TraceStep[];
  plan?: AgentPlan | null;
  notes?: string[];
  /** Plan steps the assistant never closed. Shown loudly — an answer that
   *  skipped half its own plan is exactly what the plan exists to expose. */
  unfinished?: string[];
  /** Open and unfoldable while the loop is going. */
  running?: boolean;
  truncated?: boolean;
  totalMs?: number;
}) {
  const [open, setOpen] = useState(false);
  if (!steps.length && !plan) return null;

  const shown = running || open;
  const lookups = steps.reduce((n, s) => n + s.calls.length, 0);

  return (
    <div className={"atrace" + (running ? " live" : "")}>
      {/* The plan sits outside the collapsible section deliberately: it is the
          statement of what was attempted, and hiding that behind a disclosure
          would put the answer's own scope one click away from the reader. */}
      {plan && <PlanBlock plan={plan} running={running} />}

      <button
        className="atrace-toggle"
        onClick={() => !running && setOpen((v) => !v)}
        aria-expanded={shown}
        disabled={running || !steps.length}
      >
        <Icon name={running ? "search" : "check"} size={12} />
        <span>
          {running
            ? "Looking things up…"
            : `${lookups} lookup${lookups === 1 ? "" : "s"}${totalMs ? ` · ${(totalMs / 1000).toFixed(1)}s` : ""}`}
        </span>
        {!running && !!steps.length && <Icon name="chevron" size={11} className={"atrace-chev" + (shown ? " on" : "")} />}
      </button>

      {shown && (
        <div className="atrace-body">
          {steps.map((s, i) => (
            <div key={s.step} className="atrace-step">
              {/* Before the round's stated intent, because it came before it:
                  this is what the model worked through, and `thought` is what
                  it decided to say about it. Live only, and open only on the
                  round still going — an earlier round's scratchpad is noise
                  once its lookups have come back. */}
              {s.reasoning && (
                <ThinkingPanel text={s.reasoning} compact running={!!running && i === steps.length - 1} />
              )}
              {s.thought && <p className="atrace-thought">{s.thought}</p>}
              <ul className="atrace-rows">
                {s.calls.map((call, i) => (
                  <Row key={call.id || i} call={call} run={s.runs.find((r) => r.call.id === call.id)} />
                ))}
              </ul>
            </div>
          ))}

          {/* What it worked out, as opposed to what it read. Often the more
              useful half — a conclusion outlives the tool output it came from. */}
          {!!notes?.length && (
            <div className="atrace-notes">
              {notes.map((n, i) => (
                <p key={i} className="atrace-noteline">
                  {n}
                </p>
              ))}
            </div>
          )}

          {/* Both said plainly rather than hidden. An answer written without
              the last lookup is worth reading and worth doubting. */}
          {!!unfinished?.length && (
            <p className="atrace-note warn">
              Answered without finishing its own plan: {unfinished.join("; ")}. Treat this answer as partial.
            </p>
          )}
          {truncated && (
            <p className="atrace-note">
              Stopped at the lookup limit — this answer may be missing something. Raise the effort to give it more room.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Both callers hand in different shapes; this is the one place they become
 *  the same one, so the live and saved views cannot drift. */
export function stepsFromTrace(steps: { thought: string; runs: ToolRun[] }[]): TraceStep[] {
  return steps.map((s, i) => ({ step: i + 1, thought: s.thought, calls: s.runs.map((r) => r.call), runs: s.runs }));
}
