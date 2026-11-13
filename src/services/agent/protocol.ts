/* ============================================================================
 * protocol.ts — one tool catalogue, two ways onto the wire.
 *
 * `native` is the backend's own tools/tool_calls fields. Every hosted model is
 * trained on it, it is reliable, and it keeps the arguments out of the prose.
 *
 * `text` is a fenced ```drill-call block the model writes into its reply,
 * parsed back out here. This is not a sad fallback: it is what lets the whole
 * agent loop run on Ollama and llama.cpp, which backends.ts already refuses to
 * rely on for a `tools` field, and it is the convention this codebase uses
 * everywhere else — `drill-memory` in chatContext.ts, `drill-journal` in the
 * journal writer. A local model gets the same assistant, more slowly.
 *
 * Both paths produce `ToolCall[]`, so services/agent/loop.ts never branches on
 * protocol after this file. That is deliberate: the last time two code paths
 * had to agree about tokenisation (retrieval and dedup) the fix was to make
 * them share one function, and the same reasoning applies here.
 * ========================================================================== */
import * as U from "@/lib/util";
import type { Tool, ToolCall, ToolProtocol } from "@/types/agent";
import type { BackendType } from "@/types";

/* ------------------------------------------------------------ which one -- */

/**
 * Which protocol a backend gets.
 *
 * OpenRouter and Groq both proxy models whose tool support is the model's, not
 * the gateway's — but a model that ignores `tools` simply answers in prose,
 * which the loop reads as "no calls, this is the final answer". That degrades
 * to a single call, which is exactly the right failure.
 *
 * Ollama's /api/chat does have a `tools` field on recent versions, but it is
 * silently ignored by older builds and by many GGUF chat templates, and a
 * silently ignored tools array produces a model that hallucinates having
 * searched. Text is the honest choice there: it works or it visibly does not.
 *
 * `tools` is the catalogue's verdict on the model itself, and only a "no"
 * moves anything. The comment above was written when the loop was a mode you
 * chose; with Auto the default, every message goes through here, and the
 * "model that ignores `tools`" turned out not to be the failure OpenRouter
 * actually has — sent to a model with no tool support it refuses the whole
 * request ("no endpoints found that support tool use"). So a model the
 * catalogue says has none gets the text protocol, which asks for nothing but
 * prose. Not knowing stays native, as every three-state verdict here does,
 * and `isToolRefusal` below catches the case the catalogue got wrong.
 */
export function protocolFor(backend: BackendType, tools?: boolean): ToolProtocol {
  if (backend === "ollama" || backend === "custom") return "text";
  return tools === false ? "text" : "native";
}

/**
 * Whether an error is a gateway refusing the `tools` field, rather than the
 * request failing for any other reason.
 *
 * The catalogue is a day old at best and knows nothing about Groq's own ids,
 * so a model can still turn out to take no tools. That refusal arrives before
 * a single token, which makes it safe to ask again on the text protocol —
 * and the alternative is an error box on a plain "hello" in a thread that
 * never asked for a lookup. Matched on the words, because every provider
 * spells the code differently and they all name the thing they refused.
 */
export function isToolRefusal(e: unknown): boolean {
  const msg = (e as Error)?.message || "";
  if (!/\b(400|404|422)\b/.test(msg)) return false;
  return /tool[ _-]?(use|call|choice|s\b)|function[ _-]?call/i.test(msg);
}

/* --------------------------------------------------------------- native -- */

/** The OpenAI `tools` array. JSON Schema is built from our cut-down ToolParam
 *  rather than stored as schema, so the catalogue stays readable and there is
 *  no second copy of the argument list to drift. */
export function compileNative(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(t.schema.properties).map(([key, p]) => [
            key,
            {
              type: p.type,
              description: p.description,
              ...(p.enum ? { enum: [...p.enum] } : {})
            }
          ])
        ),
        required: t.schema.required
      }
    }
  }));
}

/* ----------------------------------------------------------------- text -- */

/** The fenced block the text protocol asks for. Tolerant about what surrounds
 *  it: models reliably add a sentence before and often one after. */
const CALL_BLOCK = /```(?:drill-call|drill_call)\s*([\s\S]*?)```/gi;

/**
 * Render the catalogue as prose, for a model that cannot be handed a schema.
 *
 * Argument types are spelled out because a text-protocol model has nothing but
 * this to go on, and `limit` arriving as the string "eight" is a step wasted.
 * Required arguments are marked; optional ones show their default, which is
 * what stops a model passing every argument on every call.
 */
export function describeForText(tools: Tool[]): string {
  const lines = tools.map((t) => {
    const args = Object.entries(t.schema.properties).map(([key, p]) => {
      const req = t.schema.required.includes(key);
      const bits = [`${key}: ${p.type}${req ? "" : "?"}`];
      if (p.enum) bits.push(`one of ${p.enum.join(" | ")}`);
      if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`);
      return `      ${bits.join(" — ")}  ${p.description}`;
    });
    return `  ${t.name}${t.kind === "write" ? "  [writes]" : ""}\n      ${t.description}${args.length ? "\n" + args.join("\n") : "\n      (no arguments)"}`;
  });
  return lines.join("\n\n");
}

/**
 * The instructions that make the text protocol work at all. Kept beside the
 * parser, because a change to one is always a change to the other.
 *
 * The worked example is built from the catalogue rather than written out,
 * because a hardcoded one rots silently: the first version of this string
 * named `memory_search` and survived the rename that removed that tool, which
 * meant every local model was shown an example calling a tool that no longer
 * existed — and only on the text protocol, which is the path least likely to
 * be noticed. Deriving it means the example is always callable.
 */
export function textProtocolRules(tools: Tool[]): string {
  /* Prefer a read tool that actually takes an argument. Picking the first read
     tool outright landed on `overview`, whose schema is empty — a valid
     example that demonstrates nothing, since passing arguments is the half a
     text-protocol model is most likely to get wrong. */
  const example =
    tools.find((t) => t.kind === "read" && Object.keys(t.schema.properties).length) ||
    tools.find((t) => t.kind === "read") ||
    tools[0];
  const arg = example ? Object.keys(example.schema.properties)[0] : "";
  const sample = arg
    ? `{"calls":[{"name":"${example.name}","args":{"${arg}":"backprop chain rule"}}]}`
    : `{"calls":[{"name":"${example?.name ?? "overview"}","args":{}}]}`;
  return (
  "=== HOW TO USE A TOOL ===\n" +
  "To use tools, write one fenced block at the very end of your message:\n\n" +
  "```drill-call\n" +
  sample +
  "\n```\n\n" +
  "Rules:\n" +
  "- Put a short sentence before the block saying what you are looking for. The learner sees that sentence.\n" +
  "- Several calls in one block run together — do that whenever they do not depend on each other, it is faster.\n" +
  "- Stop and write your answer as soon as you know enough. A block is a request for more information, so writing " +
  "one means you are NOT finished, and anything you write after it is discarded.\n" +
  "- Never invent a result. If you did not call the tool, you do not know.\n" +
  "- When you have what you need, reply normally with no block at all."
  );
}

/**
 * Pull calls out of a text-protocol reply.
 *
 * Returns the prose with every block removed, so the loop can show the
 * model's stated intent and — on the final step — render what is left as the
 * answer. A malformed block is stripped and reported as no calls rather than
 * surfaced: the sentence before it is still worth showing, and a JSON parse
 * error the learner cannot act on is noise.
 */
export function parseTextCalls(reply: string): { thought: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  /* A fresh regex per parse. CALL_BLOCK is /g, and a shared /g regex carries
     lastIndex between calls — the second parse would start mid-string and miss
     the block entirely, which is the kind of bug that only shows up on the
     second step of the loop. */
  const re = new RegExp(CALL_BLOCK.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply))) {
    try {
      const raw = JSON.parse(m[1].trim()) as { calls?: Record<string, unknown>[] };
      for (const c of Array.isArray(raw?.calls) ? raw.calls : []) {
        if (!c || typeof c.name !== "string" || !c.name.trim()) continue;
        calls.push({
          id: U.uuid(),
          name: c.name.trim(),
          args: (c.args && typeof c.args === "object" ? c.args : {}) as Record<string, unknown>
        });
      }
    } catch {
      /* Unparseable — the prose still stands. */
    }
  }
  const thought = reply.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
  return { thought, calls };
}

/** How a tool result is fed back under the text protocol. Native has a `tool`
 *  role for this; text has to put it in a user message, and it must be
 *  unmistakably machine output or the model starts answering it as if the
 *  learner had typed it. */
export function renderTextResults(runs: { call: ToolCall; text: string }[]): string {
  return (
    "=== TOOL RESULTS ===\n" +
    runs.map((r) => `--- ${r.call.name} ---\n${r.text}`).join("\n\n") +
    "\n=== END TOOL RESULTS ===\n" +
    "This is tool output, not the learner speaking. Continue: either call more tools, or write your answer."
  );
}
