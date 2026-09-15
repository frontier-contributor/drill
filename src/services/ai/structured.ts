/* ============================================================================
 * structured.ts — one-shot operations that must come back as data.
 *
 * Rollup, journal, distill, exam generation, marking, card writing, /remember:
 * each sends one request and parses what comes back. They used to call chat()
 * with a fixed max_tokens and hope. This sizes the request with lib/budget.ts
 * instead, and gives each exactly one recovery when the reply ran out of room.
 *
 * One recovery, not a loop, and only for running out of room:
 *
 *   A reply cut off at the token cap — empty, or JSON that stops half way — is
 *   the one failure where the same request with more room plausibly succeeds.
 *   A rejected key, a model that does not exist, or a model that answered in
 *   prose instead of JSON are not: asking again spends money twice before
 *   saying the same thing. Those throw straight through, as they always did.
 *
 *   The retry is recorded like any other call. It goes through chat(), so it
 *   lands on the run transcript and in the usage ledger, labelled " · retry".
 *   An invisible second request is exactly what the "one message, two
 *   requests" bug was, and this must never become that.
 *
 * START-HERE §2.2 still holds: this is recovery from a failed call — the same
 * argument lib/retry.ts makes for a 429 — not a second step in a pipeline.
 *
 * `chat` and the description of the model are injected, for the reason
 * agent/loop.ts takes its own: it is the only way this control flow is
 * testable with no API key, no IndexedDB and no catalogue.
 * ========================================================================== */
import { ReplyCutOff, describePlan, planBudget, samePlan, type BudgetPlan } from "@/lib/budget";
import type { ThinkingVerdict } from "@/lib/thinking";
import type { BackendType, ChatMessage, ChatOpts, FinishInfo } from "@/types";

/** What the planner needs to know about the model a call will reach. */
export interface StructuredEnv {
  backend: BackendType;
  model: string;
  verdict: ThinkingVerdict;
  maxOutput?: number;
}

export interface StructuredRequest<T, O> {
  messages: ChatMessage[];
  /** Run-transcript label. The retry is recorded as "<label> · retry". */
  label: string;
  /** What to call this in a sentence — "weekly rollup", "recall marker".
   *  Defaults to the label, which is written for a log line, not for a person. */
  what?: string;
  /** What the visible answer needs: the number each call used to pass as
   *  max_tokens on its own. */
  answerTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  override?: O;
  /** Turn the reply into data, or throw. A throw on a reply that was cut off
   *  counts as running out of room; on a complete reply it is passed on. */
  parse: (text: string) => T;
}

export type StructuredChat<O> = (messages: ChatMessage[], opts: ChatOpts, override?: O) => Promise<string>;

type Outcome<T> = { ok: true; value: T } | { ok: false; outOfRoom: boolean; sawReasoning: boolean; error: unknown };

export function makeStructured<O>(chat: StructuredChat<O>, describe: (override?: O) => StructuredEnv) {
  return async function structured<T>(req: StructuredRequest<T, O>): Promise<T> {
    const env = describe(req.override);
    const base = { answerTokens: req.answerTokens, verdict: env.verdict, backend: env.backend, maxOutput: env.maxOutput };

    const first = planBudget({ ...base, attempt: 1 });
    const one = await attempt(chat, req, first, req.label);
    if (one.ok) return one.value;
    if (!one.outOfRoom) throw one.error;

    const second = planBudget({ ...base, attempt: 2, sawReasoning: one.sawReasoning });
    if (samePlan(first, second)) throw outOfRoom(req, env.model, [first], one.sawReasoning);

    const two = await attempt(chat, req, second, req.label + " · retry");
    if (two.ok) return two.value;
    if (!two.outOfRoom) throw two.error;
    throw outOfRoom(req, env.model, [first, second], one.sawReasoning || two.sawReasoning);
  };
}

async function attempt<T, O>(
  chat: StructuredChat<O>,
  req: StructuredRequest<T, O>,
  plan: BudgetPlan,
  label: string
): Promise<Outcome<T>> {
  let finish: FinishInfo | undefined;
  let text: string;
  try {
    text = await chat(
      req.messages,
      {
        temperature: req.temperature,
        signal: req.signal,
        label,
        maxTokens: plan.maxTokens,
        ...(plan.reasoning ? { reasoning: plan.reasoning } : {}),
        ...(plan.think != null ? { think: plan.think } : {}),
        onFinish: (info) => {
          finish = info;
        }
      },
      req.override
    );
  } catch (err) {
    if (err instanceof ReplyCutOff) return { ok: false, outOfRoom: true, sawReasoning: err.reasoned, error: err };
    /* Aborts, rejected keys, dropped connections — none of them is a question
       of room, and every one of them is already explained where it was thrown. */
    throw err;
  }

  try {
    return { ok: true, value: req.parse(text) };
  } catch (err) {
    return {
      ok: false,
      /* Only a reply the provider says it cut off counts. A complete reply that
         will not parse is the model's answer, and more room will not change it. */
      outOfRoom: !!finish?.partial,
      /* A raw <think> block in the text is the same evidence as a reasoning
         field — some servers put the scratchpad in the content itself. */
      sawReasoning: !!finish?.reasoned || /<think>/i.test(text),
      error: err
    };
  }
}

function outOfRoom<T, O>(req: StructuredRequest<T, O>, model: string, plans: BudgetPlan[], reasoned: boolean): Error {
  const who = model ? model.split("/").pop() || model : "This model";
  const what = req.what || req.label;
  return new Error(
    `The ${what} ran out of room${plans.length > 1 ? " twice" : ""} (${plans.map(describePlan).join(", then ")}). ` +
      (reasoned
        ? `${who} spent the budget thinking before it wrote the answer. Pick a model with reasoning off in Settings → Connection.`
        : `${who} kept writing past the limit. Pick a model with a larger output limit in Settings → Connection.`)
  );
}
