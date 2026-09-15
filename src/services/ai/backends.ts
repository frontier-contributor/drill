/* ============================================================================
 * backends.ts — one chat() call, four places it can go.
 *
 * Adding a backend means adding one entry to BACKENDS below. Each entry
 * describes itself (does it need a key, where do you get one, what is its
 * default model) and implements two methods:
 *
 *   chat(messages, opts, ctx)  ->  Promise<string>
 *   listModels(ctx)            ->  Promise<string[]>
 *
 * A provider that can read text aloud also gets a `speech` entry, whose
 * synthesize(request, ctx) resolves to one whole clip of audio. Ollama has
 * none, and nothing offers it a voice.
 *
 * `messages` is always the OpenAI shape and adapters translate outward from
 * that. `ctx` is the resolved {apiKey, model, baseUrl, headers} for the call.
 *
 * Every fetch() here runs straight from the browser to the provider — no
 * server in between, by design (see README: bring your own key). If Drill
 * ever grows a backend, this is the file that would move server-side: keep
 * the same BackendDef shape and swap fetch() targets for calls to your API.
 * ========================================================================== */
import { CHAT_ACTIONS, availability, type ChatActionId } from "@/lib/chatActions";
import { MAX_ATTEMPTS, jitter, planRetry } from "@/lib/retry";
import { ReplyCutOff } from "@/lib/budget";
import type {
  AIContext,
  BackendDef,
  BackendType,
  ChatMessage,
  ChatOpts,
  Citation,
  SpeechDef,
  TokenUsage,
  WireToolCall
} from "@/types";

/** True for the exception fetch throws when an AbortSignal fires. Callers
 *  treat this as "the user stopped it", not as a failure to report. */
export function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

/**
 * A reply with no text in it, explained.
 *
 * Reasoning models are the usual cause: the thinking counts against
 * max_tokens, so the budget can be gone before the visible answer starts, and
 * what comes back is an empty `content` with `finish_reason: "length"` and
 * possibly a full `reasoning` block. Reported as "the model said nothing" it
 * is unfixable; reported as this it takes one settings change.
 *
 * The two out-of-room shapes are a ReplyCutOff rather than a plain Error, so
 * services/ai/structured.ts can give a one-shot operation more room instead of
 * matching on this wording.
 */
function emptyReplyError(label: string, finish: string | undefined, reasoning: string): Error {
  if (finish === "length") {
    return new ReplyCutOff(
      label +
        " hit the token cap before writing an answer" +
        (reasoning ? " — it spent the whole budget thinking" : "") +
        ". Pick a model with reasoning off, or a smaller task.",
      finish,
      !!reasoning
    );
  }
  if (reasoning) {
    return new ReplyCutOff(
      label + " returned only its reasoning and no answer. This model needs its reasoning output disabled, or a different model.",
      finish,
      true
    );
  }
  return new Error(label + " returned an empty reply" + (finish ? " (finish_reason: " + finish + ")" : "") + ".");
}

/** OpenAI-shaped usage blocks, which OpenRouter, OpenAI and most compatible
 *  servers all return under the same key names. The *_details sub-objects are
 *  optional and absent on most compatible servers; missing means zero. */
function readOpenAIUsage(j: unknown): TokenUsage | undefined {
  const u = (
    j as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    }
  )?.usage;
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    cachedPromptTokens: u.prompt_tokens_details?.cached_tokens || 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens || 0,
    /* OpenRouter reports what it actually charged. That figure includes web
       search fees, which no tokens-times-price sum can see, so it wins over
       the reconstructed one wherever it is present. */
    reportedCost: typeof u.cost === "number" ? u.cost : undefined
  };
}

/** Apply the caller's requested actions, filtered to what this backend and
 *  this model can actually do. Unsupported ones are dropped rather than sent
 *  — the composer disables the chip, this is the belt to that braces.
 *
 *  The model half of the filter matters more than it looks: an action left on
 *  while the model chip moves to something that cannot do it stays in
 *  `conversation.actions`, deliberately, so it comes back when you switch the
 *  model back. That only works because the send path refuses to send it in
 *  the meantime. */
function applyActions(
  body: Record<string, unknown>,
  want: ChatActionId[] | undefined,
  backend: BackendType,
  model: string
): void {
  if (!want?.length) return;
  const can = BACKENDS[backend]?.supports;
  for (const id of want) {
    if (!availability(id, can, model).can) continue;
    CHAT_ACTIONS[id]?.apply(body, backend);
  }
}

/** A one-shot operation's reasoning control, from lib/budget.ts.
 *
 *  Never alongside the Think action: that switch is the learner's own word
 *  about this reply, and a planner turning it down underneath them would be two
 *  controls fighting over one parameter. OpenRouter and Ollama only — Groq
 *  refuses a reasoning parameter on a model that has none, and the custom
 *  backend has no dialect to guess (the same reasoning as lib/chatActions.ts). */
function applyBudgetControls(body: Record<string, unknown>, opts: ChatOpts, backend: BackendType): void {
  if (opts.actions?.includes("think")) return;
  if (backend === "openrouter" && opts.reasoning) body.reasoning = { effort: opts.reasoning.effort };
  if (backend === "ollama" && opts.think != null) body.think = opts.think;
}

/** OpenAI-shaped citation annotations, as OpenRouter returns them for a
 *  web-search reply. Tolerant about where they hang: the annotations array
 *  appears on the completed message, and on streamed deltas for some
 *  engines, so both paths funnel through here. */
function readCitations(node: unknown): Citation[] {
  const list = (node as { annotations?: unknown[] })?.annotations;
  if (!Array.isArray(list)) return [];
  const out: Citation[] = [];
  for (const raw of list) {
    const a = raw as { type?: string; url_citation?: Record<string, unknown> };
    const c = a?.url_citation;
    if (!c || typeof c.url !== "string") continue;
    out.push({
      url: c.url,
      title: typeof c.title === "string" && c.title.trim() ? c.title : c.url,
      content: typeof c.content === "string" ? c.content : undefined,
      start: typeof c.start_index === "number" ? c.start_index : undefined,
      end: typeof c.end_index === "number" ? c.end_index : undefined
    });
  }
  return out;
}

/** Same source twice is one source. Keeps first-seen order, which is the
 *  order the model referred to them in. */
function dedupeCitations(list: Citation[]): Citation[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

/* ----------------------------------------------------------- tool calling */

/** Our ChatMessage translated to the OpenAI wire shape. The tool fields are
 *  omitted entirely when absent rather than sent as undefined — some strict
 *  gateways reject a null `tool_calls` on a plain assistant message. */
function toWire(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.name) out.name = m.name;
  return out;
}

/**
 * Tool calls out of a completed message.
 *
 * `arguments` is a JSON *string* by the spec, and models do return it
 * malformed — a truncated object, or prose where JSON was asked for. An
 * unparseable call becomes an empty argument object rather than being dropped:
 * the tool then reports what it needed, which the model can act on, whereas a
 * silently vanished call looks to the loop like "no calls, answer now" and
 * produces a confident reply built on nothing.
 */
function readToolCalls(node: unknown): WireToolCall[] {
  const list = (node as { tool_calls?: unknown[] })?.tool_calls;
  if (!Array.isArray(list)) return [];
  const out: WireToolCall[] = [];
  for (const raw of list) {
    const c = raw as { id?: string; function?: { name?: string; arguments?: string } };
    const name = c?.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(c.function?.arguments || "{}");
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      /* Left empty on purpose — see above. */
    }
    out.push({ id: c.id || name + ":" + out.length, name, args });
  }
  return out;
}

/**
 * Reassemble tool calls from a stream.
 *
 * Streamed calls arrive as fragments keyed by `index`, with the name on the
 * first fragment and `arguments` split across many — so they have to be
 * accumulated by index and only parsed once the stream ends. Parsing each
 * delta would fail on every fragment but the last.
 */
class ToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string; args: string }>();

  add(delta: unknown): void {
    const list = (delta as { tool_calls?: unknown[] })?.tool_calls;
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const c = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
      const i = typeof c.index === "number" ? c.index : 0;
      const slot = this.byIndex.get(i) || { id: "", name: "", args: "" };
      if (c.id) slot.id = c.id;
      if (c.function?.name) slot.name = c.function.name;
      if (c.function?.arguments) slot.args += c.function.arguments;
      this.byIndex.set(i, slot);
    }
  }

  done(): WireToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, s]) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(s.args || "{}");
          if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
        } catch {
          /* see readToolCalls */
        }
        return { id: s.id || s.name + ":" + i, name: s.name, args };
      })
      .filter((c) => c.name);
  }
}

/* ---------------------------------------------------------------- shared */

function shortErr(t: string): string {
  try {
    const j = JSON.parse(t) as { error?: { message?: string; code?: string }; message?: string };
    return (j.error && (j.error.message || j.error.code)) || j.message || String(t).slice(0, 240);
  } catch {
    return String(t).slice(0, 240) || "no detail";
  }
}

/** Turn a failed response into something that names the actual fix. */
function httpError(label: string, res: Response, body: string, tried = ""): Error {
  const detail = shortErr(body);
  if (res.status === 401 || res.status === 403) {
    return new Error(label + " rejected the key (" + res.status + "). Check it in Settings — " + detail);
  }
  if (res.status === 404) {
    return new Error(label + " 404 — usually a model name that does not exist on this backend. " + detail);
  }
  if (res.status === 429) {
    return new Error(label + " rate limit or out of credit (429)" + tried + ". " + detail);
  }
  /* A thread that outgrew its model is the one 400 with an obvious fix, and
     "400 — invalid_request_error" is the least useful way to say it. The
     wording is checked rather than an error code because every provider
     spells the code differently and they all put the words in the message. */
  if (res.status === 400 && /context|token|too long|maximum.*length/i.test(body)) {
    return new Error(
      "This conversation is now longer than " +
        label +
        " will accept in one request. Lower Effort in the composer to send less " +
        "history, pick a model with a bigger context window, or branch from a message part-way up to carry " +
        "the thread on in a fresh one. — " +
        detail
    );
  }
  return new Error(label + " " + res.status + tried + " — " + detail);
}

/**
 * Wait, unless the user stopped it first.
 *
 * A plain setTimeout would hold the Stop button hostage for the length of the
 * backoff: you press stop, nothing happens for four seconds, and then the
 * request you cancelled goes out anyway.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * POST, and try again when the failure is the kind that might not repeat.
 *
 * Nothing in this app retried anything before, so a 429 from a free tier — the
 * most ordinary failure a chat client meets — ended the message and left the
 * user to press Retry by hand. So did a gateway 502 and a wifi handover.
 *
 * `started()` is the safety rail, and it is the whole reason this lives here
 * rather than around `chat()`. Once a single token has reached the caller the
 * request is no longer repeatable: restarting it would either duplicate what
 * was already shown or throw it away. Both streaming adapters pass a closure
 * over their own accumulator, so the rule is enforced by the thing that knows.
 */
async function postWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  signal: AbortSignal | undefined,
  started: () => boolean,
  /** A backend's own wording for a status the generic message would fumble —
   *  Ollama's 404 is "you have not pulled that model", not "bad model name".
   *  Returning null falls through to httpError. */
  mapError?: (res: Response, body: string) => Error | null,
  /** Whether this backend runs on the caller's own machine — decides which
   *  advice a network-level failure gives. See reachError(). */
  local = false
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    let networkError: unknown;

    try {
      res = await fetch(url, init);
    } catch (e) {
      if (isAbort(e)) throw e;
      networkError = e;
    }

    if (res && res.ok) return res;

    const plan = planRetry({
      attempt,
      status: res?.status,
      retryAfter: res?.headers.get("retry-after"),
      networkError: !res,
      started: started()
    });

    if (!plan.retry) {
      if (!res) throw reachError(label, url, networkError, local);
      const body = await res.text().catch(() => "");
      throw mapError?.(res, body) || httpError(label, res, body, attempt > 1 ? ` (tried ${attempt} times)` : "");
    }

    /* The body of a failed attempt is never read, so it has to be released
       explicitly or the connection is held until GC gets round to it. */
    if (res) void res.body?.cancel().catch(() => undefined);
    console.warn(`${label}: ${plan.reason}; retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
    await sleep(jitter(plan.delayMs), signal);
  }
}

/** A network-level failure gives no status and no body, so the two backend
 *  families need different advice. A local server refusing the browser's
 *  origin is the ordinary Ollama/llama.cpp story; a hosted API that never
 *  responds is not — telling that user to set OLLAMA_ORIGINS was pure noise
 *  that buried the real question (internet down? extension blocking it?)
 *  under advice for a server they don't run. */
function reachError(label: string, url: string, e: unknown, local = false): Error {
  const origin = window.location.origin;
  const hint = local
    ? "Either it is not running, or it is refusing requests from " +
      origin +
      " — set OLLAMA_ORIGINS=* (or the equivalent CORS setting) and restart it."
    : "Check your internet connection — or a browser extension (ad blocker, privacy tool) may be blocking the request.";
  return new Error("Could not reach " + label + " at " + url + ". " + hint + " [" + ((e as Error)?.message || "network error") + "]");
}

/** Read an SSE stream, hand each `data:` payload to `onEvent`. */
async function readSSE(res: Response, onEvent: (j: any) => void): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) return;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line.charAt(0) === ":" || line.indexOf("data:") !== 0) continue;
      const p = line.slice(5).trim();
      if (p === "[DONE]") continue;
      try {
        onEvent(JSON.parse(p));
      } catch {
        /* partial frame, skip */
      }
    }
  }
}

/** Read newline-delimited JSON — Ollama's native streaming format. */
async function readNDJSON(res: Response, onObj: (j: any) => void): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) return;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onObj(JSON.parse(line));
      } catch {
        /* partial frame, skip */
      }
    }
  }
}

/* ------------------------------------------------- OpenAI-compatible core */
/** OpenRouter, OpenAI, llama.cpp, LM Studio, vLLM and text-generation-webui
 *  all speak this. Only the headers and the default host differ. */
function openAICompatible(
  label: string,
  id: BackendType,
  headerFn: (ctx: AIContext) => Record<string, string>,
  /** True for a backend that normally runs on the caller's own machine —
   *  only "custom" today. Decides the wording of a network-level failure. */
  local = false
): Pick<BackendDef, "chat" | "listModels"> {
  return {
    async chat(messages: ChatMessage[], opts: ChatOpts, ctx: AIContext): Promise<string> {
      const url = ctx.baseUrl + "/chat/completions";
      const body: Record<string, unknown> = {
        model: ctx.model,
        messages: messages.map(toWire),
        temperature: opts.temperature == null ? 0.4 : opts.temperature,
        stream: !!opts.onToken
      };
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      /* Sent only when the caller asked for tools. An empty `tools: []` is
         rejected by some gateways and changes behaviour on others, so absent
         has to mean absent. */
      if (opts.tools?.length) body.tools = opts.tools;
      applyBudgetControls(body, opts, id);
      /* Actions the caller asked for, filtered to what this backend and model
         can actually do. `stream_options: {include_usage:true}` used to be set
         here; OpenRouter deprecated it and returns usage unconditionally. */
      applyActions(body, opts.actions, id, ctx.model);

      /* Tracks whether anything has reached the caller, so the retry loop can
         refuse to restart a stream that has already put text on the screen. */
      let delivered = false;
      const res = await postWithRetry(
        url,
        { method: "POST", headers: headerFn(ctx), body: JSON.stringify(body), signal: opts.signal },
        label,
        opts.signal,
        () => delivered,
        undefined,
        local
      );
      if (!opts.onToken) {
        const j = await res.json();
        const u = readOpenAIUsage(j);
        if (u && opts.onUsage) opts.onUsage(u);
        const choice = (j.choices && j.choices[0]) || {};
        const message = choice.message || {};
        if (opts.onCitations) {
          const cites = dedupeCitations(readCitations(message));
          if (cites.length) opts.onCitations(cites);
        }
        const toolCalls = readToolCalls(message);
        if (toolCalls.length && opts.onToolCalls) opts.onToolCalls(toolCalls);
        const text = message.content || "";
        const reasoning = String(message.reasoning || message.reasoning_content || "");
        /* Reasoning shows up in any of three places depending on the model and
           the provider behind the gateway — plain text, structured details, or
           only as a count in usage — and each is evidence it happened. */
        const reasoned =
          !!reasoning ||
          (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) ||
          (u?.reasoningTokens || 0) > 0;
        opts.onFinish?.({ reason: choice.finish_reason, reasoned, partial: choice.finish_reason === "length" });
        /* A reply that is nothing but tool calls has empty content and is
           entirely correct — it is the normal shape of an agent step. Throwing
           "the model said nothing" here is what would break the loop on its
           first useful turn. */
        if (!text && !toolCalls.length) throw emptyReplyError(label, choice.finish_reason, reasoned ? reasoning || "yes" : "");
        return text;
      }
      let out = "";
      let reasoned = false;
      let finish: string | undefined;
      let usage: TokenUsage | undefined;
      /* Where citations arrive in a stream is not documented and differs by
         search engine, so every plausible carrier is read and the result is
         deduped by url. Missing them entirely would silently drop the whole
         point of a web-search reply. */
      let cites: Citation[] = [];
      const calls = new ToolCallAccumulator();
      await readSSE(res, (j) => {
        const u = readOpenAIUsage(j);
        if (u) usage = u;
        cites = cites.concat(readCitations(j));
        const choice = j.choices && j.choices[0];
        if (!choice) return;
        if (choice.finish_reason) finish = choice.finish_reason;
        cites = cites.concat(readCitations(choice.message), readCitations(choice.delta));
        const d = choice.delta;
        if (!d) return;
        calls.add(d);
        if (d.reasoning || d.reasoning_content || (Array.isArray(d.reasoning_details) && d.reasoning_details.length)) reasoned = true;
        if (d.content) {
          out += d.content;
          delivered = true;
          opts.onToken!(d.content, out);
        }
      });
      if (usage && opts.onUsage) opts.onUsage(usage);
      if ((usage as TokenUsage | undefined)?.reasoningTokens) reasoned = true;
      opts.onFinish?.({ reason: finish, reasoned, partial: finish === "length" });
      if (opts.onCitations && cites.length) opts.onCitations(dedupeCitations(cites));
      const streamedCalls = calls.done();
      if (streamedCalls.length && opts.onToolCalls) opts.onToolCalls(streamedCalls);
      if (!out && !streamedCalls.length) throw emptyReplyError(label, finish, reasoned ? "yes" : "");
      return out;
    },

    async listModels(ctx: AIContext): Promise<string[]> {
      const url = ctx.baseUrl + "/models";
      let res: Response;
      try {
        res = await fetch(url, { headers: headerFn(ctx) });
      } catch (e) {
        throw reachError(label, url, e, local);
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw httpError(label, res, t);
      }
      const j = await res.json();
      return ((j.data || j.models || []) as unknown[])
        .map((m) => (typeof m === "string" ? m : (m as { id?: string; name?: string }).id || (m as { name?: string }).name))
        .filter(Boolean)
        .sort() as string[];
    }
  };
}

/* ---------------------------------------------------------------- headers */

/** OpenRouter wants an origin it can attribute the call to. */
function openRouterHeaders(ctx: AIContext): Record<string, string> {
  const ref = window.location.origin && window.location.origin !== "null" ? window.location.origin : "http://localhost";
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + ctx.apiKey,
    "HTTP-Referer": ref,
    "X-Title": "Drill",
    ...ctx.headers
  };
}

function groqHeaders(ctx: AIContext): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: "Bearer " + ctx.apiKey, ...ctx.headers };
}

function customHeaders(ctx: AIContext): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...ctx.headers };
  if (ctx.apiKey) h.Authorization = "Bearer " + ctx.apiKey;
  return h;
}

/* ----------------------------------------------------------------- speech */

/**
 * OpenAI's /audio/speech, which OpenRouter, Groq and most compatible servers
 * speak: one POST per piece of text, answered with the whole clip.
 *
 * Retried through the same loop as chat, with `started` always false. That is
 * safe here in a way it is not for a stream: a clip arrives whole or not at
 * all, so a request that failed has put nothing in anyone's ears and asking
 * again cannot repeat a word.
 *
 * Two of chat's error messages would be wrong for speech, so they are
 * replaced. A 400 that mentions tokens becomes chat's "this conversation is
 * too long", and a speech request has no conversation. A 404 from a local
 * server almost always means a server with no speech endpoint at all.
 */
function openAISpeech(
  label: string,
  headerFn: (ctx: AIContext) => Record<string, string>,
  format: "mp3" | "wav",
  local = false
): SpeechDef["synthesize"] {
  return async (req, ctx) => {
    const url = ctx.baseUrl + "/audio/speech";
    const body = { model: req.model, input: req.input, voice: req.voice, response_format: format };
    const res = await postWithRetry(
      url,
      { method: "POST", headers: headerFn(ctx), body: JSON.stringify(body), signal: req.signal },
      label,
      req.signal,
      () => false,
      (r, text) => {
        if (r.status === 404) {
          return new Error(
            local
              ? `${label} has no speech endpoint at ${url}. Point Base URL at a server that speaks OpenAI's /audio/speech, or use this device's voice.`
              : `${label} 404 — usually a speech model or voice it does not have (${req.model}, ${req.voice}). ${shortErr(text)}`
          );
        }
        if (r.status === 400 || r.status === 422) {
          return new Error(`${label} refused the speech request (${r.status}) — ${shortErr(text)}`);
        }
        return null;
      },
      local
    );
    /* OpenRouter's own advice for this endpoint: check that what came back is
       audio, and that there is some. A gateway that answers 200 with a JSON
       error would otherwise be handed to the audio element and fail there
       with a message about decoding that explains nothing. */
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (mime && !mime.startsWith("audio/") && mime !== "application/octet-stream") {
      const text = await res.text().catch(() => "");
      throw new Error(`${label} answered with ${mime} instead of audio — ${shortErr(text)}`);
    }
    const audio = await res.arrayBuffer();
    if (!audio.byteLength) throw new Error(`${label} returned an empty clip for ${req.model}.`);
    return {
      audio,
      mime: mime.startsWith("audio/") ? mime : format === "wav" ? "audio/wav" : "audio/mpeg",
      generationId: res.headers.get("x-generation-id") || undefined
    };
  };
}

/* --------------------------------------------------------------- backends */


export const BACKENDS: Record<BackendType, BackendDef> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    needsKey: true,
    local: false,
    keyUrl: "https://openrouter.ai/keys",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
    note: "One key, every model. Has free models on the list too.",
    /* The only backend that can search: OpenRouter runs it server-side and
       injects the results into the prompt, so it stays one request. Thinking
       is a per-model question on top of this — see lib/thinking.ts. */
    supports: ["web", "think"],
    /* The catalogue this prices against is OpenRouter's own, so its ids match
       by construction. */
    pricing: "catalogue",
    speech: {
      source: "catalogue",
      /* The cheapest speech model billed by the character that also
         publishes its voices, when this was written — and pleasant enough to
         listen to for an hour. Everything else in the speech catalogue is one
         click away under Settings → Listening. */
      defaultModel: "hexgrad/kokoro-82m",
      defaultVoice: "af_heart",
      maxChars: 800,
      synthesize: openAISpeech("OpenRouter", openRouterHeaders, "mp3")
    },
    ...openAICompatible("OpenRouter", "openrouter", openRouterHeaders)
  } as BackendDef,

  groq: {
    id: "groq",
    label: "Groq",
    needsKey: true,
    local: false,
    keyUrl: "https://console.groq.com/keys",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    note: "Very fast, and free within a per-minute rate limit. Load the model list to see what it serves today.",
    /* A claim about the free tier, not a lookup: Groq's own model ids
       ("llama-3.3-70b-versatile") do not match the OpenRouter catalogue's
       ("meta-llama/llama-3.3-70b-instruct"), and a hand-written mapping
       between them is exactly the table pricing.ts exists to avoid. If you
       move onto a paid Groq plan, change this to "unpriced" — an honest
       blank beats a confident zero. */
    pricing: "free",
    speech: {
      source: "fixed",
      defaultModel: "canopylabs/orpheus-v1-english",
      defaultVoice: "hannah",
      /* A hard limit, not a preference: Orpheus refuses more than 200
         characters in one request. The free tier also allows ten requests a
         minute and a hundred a day, which is why Groq is never the automatic
         choice — one long reply can spend a day's allowance. */
      maxChars: 200,
      /* Groq publishes no list of its speech models or their voices, so the
         documented ones are written down here. */
      models: {
        "canopylabs/orpheus-v1-english": ["autumn", "diana", "hannah", "austin", "daniel", "troy"],
        "canopylabs/orpheus-arabic-saudi": ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"]
      },
      synthesize: openAISpeech("Groq", groqHeaders, "wav")
    },
    ...openAICompatible("Groq", "groq", groqHeaders)
  } as BackendDef,

  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    /* Runs on your own machine. The one backend where $0 is a fact. */
    pricing: "free",
    needsKey: false,
    local: true,
    keyUrl: "https://ollama.com/download",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "llama3.1:8b",
    note: "Runs on your machine, costs nothing. Needs OLLAMA_ORIGINS=* so the browser is allowed to call it.",
    /* Ollama has a native `think` flag, so the local backend gets the thinking
       switch too. Whether the model in front of it can actually think is not
       knowable from here — the price catalogue has never heard of
       "qwen3:8b" — so lib/thinking.ts returns "unknown" and the switch stays
       live. Ollama refuses with a clear message when it cannot, which is a
       better answer than a permanently grey button on the one backend where
       reasoning models are what people run. */
    supports: ["think"],

    async chat(messages, opts, ctx) {
      const url = ctx.baseUrl + "/api/chat";
      const body: Record<string, unknown> = {
        model: ctx.model,
        messages,
        stream: !!opts.onToken,
        options: { temperature: opts.temperature == null ? 0.4 : opts.temperature }
      };
      if (opts.maxTokens) (body.options as Record<string, unknown>).num_predict = opts.maxTokens;
      applyBudgetControls(body, opts, "ollama");
      applyActions(body, opts.actions, "ollama", ctx.model);

      /* Retried like the hosted backends, and not only for symmetry: a local
         server that is still loading a model into memory refuses with a 5xx,
         and asking again a second later is exactly the right answer. */
      let delivered = false;
      const res = await postWithRetry(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...ctx.headers },
          body: JSON.stringify(body),
          signal: opts.signal
        },
        "Ollama",
        opts.signal,
        () => delivered,
        (r) =>
          r.status === 404
            ? new Error('Ollama has no model called "' + ctx.model + '". Pull it first:  ollama pull ' + ctx.model)
            : null,
        true
      );
      const reportOllamaUsage = (j: { prompt_eval_count?: number; eval_count?: number }) => {
        if (!opts.onUsage) return;
        if (j.prompt_eval_count == null && j.eval_count == null) return;
        opts.onUsage({ promptTokens: j.prompt_eval_count || 0, completionTokens: j.eval_count || 0 });
      };
      if (!opts.onToken) {
        const j = await res.json();
        reportOllamaUsage(j);
        const text = (j.message && j.message.content) || j.response || "";
        const thinking = String((j.message && j.message.thinking) || "");
        opts.onFinish?.({ reason: j.done_reason, reasoned: !!thinking, partial: j.done_reason === "length" });
        if (!text) throw emptyReplyError("Ollama", j.done_reason, thinking);
        return text;
      }
      let out = "";
      let thought = false;
      let doneReason: string | undefined;
      await readNDJSON(res, (j) => {
        if (j.done) {
          reportOllamaUsage(j);
          doneReason = j.done_reason;
        }
        if (j.message && j.message.thinking) thought = true;
        const t = (j.message && j.message.content) || j.response;
        if (t) {
          out += t;
          delivered = true;
          opts.onToken!(t, out);
        }
      });
      opts.onFinish?.({ reason: doneReason, reasoned: thought, partial: doneReason === "length" });
      /* This used to return "" and leave the caller to say "empty reply",
         which threw away the one fact that explains it. */
      if (!out) throw emptyReplyError("Ollama", doneReason, thought ? "yes" : "");
      return out;
    },

    async listModels(ctx) {
      const url = ctx.baseUrl + "/api/tags";
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        throw reachError("Ollama", url, e, true);
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw httpError("Ollama", res, t);
      }
      const j = await res.json();
      return ((j.models || []) as { name?: string; model?: string }[])
        .map((m) => m.name || m.model)
        .filter(Boolean)
        .sort() as string[];
    }
  },

  /* Anything else that speaks the OpenAI wire format: llama.cpp's server,
     LM Studio, vLLM, text-generation-webui, a company gateway. */
  custom: {
    id: "custom",
    label: "OpenAI-compatible (llama.cpp, LM Studio, vLLM…)",
    needsKey: false,
    local: true,
    keyUrl: "",
    defaultBaseUrl: "http://localhost:8080/v1",
    defaultModel: "local-model",
    note: "Point Base URL at any /v1 endpoint that speaks the OpenAI chat format. Key optional.",
    /* This used to report $0, on the assumption that a custom endpoint is a
       local one. It is not: pointing this at a paid hosted API is the obvious
       thing to do with it, and then every call was billed and reported free.
       Unpriced says "we do not know", which is the truth here. */
    pricing: "unpriced",
    speech: {
      source: "typed",
      /* OpenAI's own names, which most compatible speech servers — LocalAI,
         openedai-speech, Kokoro-FastAPI — also answer to. */
      defaultModel: "tts-1",
      defaultVoice: "alloy",
      maxChars: 800,
      synthesize: openAISpeech("Backend", customHeaders, "mp3", true)
    },
    ...openAICompatible("Backend", "custom", customHeaders, true)
  } as BackendDef
};

export const BACKEND_ORDER: BackendType[] = ["openrouter", "groq", "ollama", "custom"];
