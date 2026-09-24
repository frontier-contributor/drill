/* ============================================================================
 * prompt.ts — what the assistant is told before it is given hands.
 *
 * The single-call path already has a good system prompt: a persona, plus the
 * deterministic context block from lib/chatContext.ts. The loop needs three
 * things that prompt does not say, because in a pipeline they could not go
 * wrong:
 *
 *   when to look something up   a pipeline decided that in TypeScript
 *   when to STOP looking        a pipeline could not loop
 *   what "saved" means          a pipeline never wrote anything mid-answer
 *
 * The stopping rule is the one that matters. Every bad agent loop is the same
 * bug: a model that keeps searching because searching feels like progress. It
 * is stated three times here, in three different framings, because once is not
 * enough and the failure is expensive — every extra step is a whole request.
 * ========================================================================== */
import { describeForText, textProtocolRules } from "./protocol";
import type { Tool, ToolProtocol } from "@/types/agent";

/**
 * The behavioural half. Deliberately not a persona: the learner's chosen
 * persona still leads the system message, and this is appended to it, so
 * "explain like I am five" and "look things up before answering" compose
 * instead of fighting.
 */
const AGENT_RULES =
  "=== HOW YOU WORK ===\n" +
  "You are not answering from a snapshot. You can look things up in this learner's own record — their memory, " +
  "their flashcards and how those are going, what they wrote when tested, their journal, their notes, and the " +
  "material attached to this project. Use it. An answer grounded in what they actually did beats a good general " +
  "explanation, every time.\n\n" +
  "WHEN TO LOOK:\n" +
  "- Anything about them, their progress, or their history: look it up. Never guess and never say you cannot know.\n" +
  "- Before recording anything: search memory first, so you do not save what is already there.\n" +
  "- Before diagnosing a misunderstanding: read what they actually wrote when tested. The grade says they got it " +
  "wrong; their sentence says how they were thinking, and that is the thing worth responding to.\n" +
  "- A general knowledge question with no personal angle needs no tools at all. Just answer it.\n\n" +
  "WHEN TO STOP:\n" +
  "- Stop as soon as you can answer. You are not being scored on how many tools you used.\n" +
  "- Two or three lookups is a normal investigation. If you are on your fourth, you are almost certainly " +
  "circling — write the answer you have and say what you could not find.\n" +
  "- Never call the same tool twice with near-identical arguments. If a search came back empty, it is empty; " +
  "widen it once or move on.\n" +
  "- Nothing found is a real answer. Say so plainly rather than searching again in the hope it changes.\n\n" +
  "BEING HONEST ABOUT WHAT YOU DID:\n" +
  "- A tool result is the only thing you know. If you did not call it, you did not look — never describe a card, " +
  "a memory or a journal entry you have not seen.\n" +
  "- Writing tools may only PROPOSE. When a result says something was queued for review, tell the learner it is " +
  'waiting for them — never "I have saved that". When it says saved, you may say saved.\n' +
  "- Do not narrate your tool use as it happens; the learner can see it. Write the answer, not a report of your " +
  "own process.\n" +
  "- Do not recite their context back at them or mention that you were given it, unless they ask what you can see.";

/** What the loop is for, in one line each, when writes are off. Saying this
 *  rather than silently omitting the tools stops the model promising to
 *  remember something it has no way to record. */
const READ_ONLY_NOTE =
  "\n\nNOTE: writing is switched off for this conversation. You can read everything, but you cannot save memory, " +
  "propose cards, or add to the journal. If something is worth recording, say so in your reply and let them do it.";

/**
 * Deep mode's extra discipline: say what you will do, do it, close it out.
 *
 * This exists because of the single best-documented failure of long-running
 * agents — declaring victory early. An agent with no stated plan cannot be
 * caught doing it, by itself or by the reader. Writing the plan first turns
 * "am I finished?" from a judgement call into a check the harness can also
 * make, which is what loop.ts's close-out nudge does.
 *
 * The instruction to restate the question is not politeness. A misread
 * question is the most expensive failure available here — it wastes the whole
 * budget answering the wrong thing — and restating it puts the misreading in
 * line one where the learner can stop it.
 */
const PLANNING_RULES =
  "=== WORKING TO A PLAN ===\n" +
  "Before anything else, call `plan`. Restate the question as you understood it, then list the specific things " +
  "you need to find out, one per line, in the order you will do them.\n\n" +
  "- Three to six steps. More than six means you are over-thinking a question you could just answer.\n" +
  "- Each step names something concrete you will find out — not \"research the topic\".\n" +
  "- Then work them in order, closing each with `plan_step` and one line on what it found.\n" +
  '- A step that turns out not to matter gets closed as "dropped" with the reason. That is a real outcome and ' +
  "far better than quietly skipping it.\n" +
  "- Use `note` when you work something out, so the conclusion survives even if the detail behind it scrolls away.\n" +
  "- You may NOT write your final answer while any step is still open. You will be handed the list back if you try.\n" +
  "- If what you find makes the plan wrong, close the dead steps as dropped and say so in your answer. Changing " +
  "your mind out loud is good; pretending the plan was always this one is not.";

/**
 * Voice mode's version of planning: allowed, never required.
 *
 * In voice there is no Deep to choose — the person talking should not have to
 * decide how hard their question is before asking it. So the plan tools are
 * on the table and this says when to reach for them: only for a request that
 * is really several steps. A plain question gets a plain answer in one
 * request, which is most of what anyone says out loud.
 */
function autoPlanRules(plan: string): string {
  return (
    "=== DECIDING HOW MUCH WORK THIS NEEDS ===\n" +
    "Most things said to you need no plan at all: answer them, looking something up first only if the answer " +
    "depends on it. Call `" +
    plan +
    "` only when the request is genuinely several steps — preparing for an exam, going through a whole deck, " +
    "comparing weeks, building something in parts. If you do, work it to the end exactly as it says."
  );
}

export interface AgentPromptOpts {
  /** The system message the single-call path would have built — persona plus
   *  the deterministic context block. The loop *keeps* it: the tools are for
   *  what the fixed context could not anticipate, not a replacement for
   *  knowing the basics up front. A loop that has to call `overview`
   *  before it can say hello is a slow loop. */
  base: string;
  tools: Tool[];
  protocol: ToolProtocol;
  allowWrites: boolean;
  /** Deep mode (true) adds the plan discipline; voice ("auto") offers a plan
   *  without requiring one. */
  planning: boolean | "auto";
  /** Ceiling on tool rounds, quoted to the model so "you have three steps" is
   *  a fact it can plan against rather than a wall it hits. */
  maxSteps: number;
}

export function buildAgentSystem(opts: AgentPromptOpts): string {
  const parts = [opts.base.trim(), AGENT_RULES];
  if (opts.planning === true) parts.push(PLANNING_RULES);
  else if (opts.planning === "auto") {
    const plan = opts.tools.find((t) => t.opensPlan)?.name;
    if (plan) parts.push(autoPlanRules(plan));
  }
  if (!opts.allowWrites) parts.push(READ_ONLY_NOTE.trim());

  parts.push(
    `You have at most ${opts.maxSteps} rounds of tool use for this message. Spend them like they cost something, ` +
      "because they do." +
      (opts.planning === true ? " Writing and closing the plan costs rounds too — budget for that." : "")
  );

  /* The text protocol needs the catalogue in the prompt; native gets it in the
     request's own `tools` field and repeating it there would be paying twice
     for the same list. */
  if (opts.protocol === "text") {
    parts.push("=== TOOLS AVAILABLE ===\n" + describeForText(opts.tools), textProtocolRules(opts.tools));
  }

  return parts.join("\n\n");
}
