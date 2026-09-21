/* ============================================================================
 * chatActions.ts — things a conversation can be told to do, per backend.
 *
 * The first is web search. It is written as a registry rather than a boolean
 * because more will follow, and because support is a property of the
 * *backend*, not of the app: OpenRouter runs search server-side, Ollama
 * cannot, and a toggle that silently does nothing on half the backends is the
 * dead-dial problem again.
 *
 * A backend declares what it supports (`BackendDef.supports`); an action
 * declares how to apply itself to a request body. Adding an action means one
 * entry here and one entry in the backend's `supports` list — nothing in the
 * composer or the send path needs to change.
 *
 * The second action, thinking, broke one assumption in that design: support
 * for it is not decided by the backend alone. One OpenRouter key reaches both
 * reasoning models and models that have never heard of the parameter, so an
 * action may also declare `modelSupport`, which is asked afresh every time the
 * model chip changes. lib/thinking.ts is where that question is answered; this
 * file only routes it.
 *
 * Every action must be a single-request feature. START-HERE §2.2 is "pipeline,
 * not agent loop, one API call per operation", and OpenRouter's web plugin
 * honours that: their servers run the search and inject the results as prompt
 * text, so the model answers in the same completion. If an action would need
 * a second round trip, it does not belong here — it belongs in Phase 8.
 * ========================================================================== */
import { thinkingSupport } from "@/lib/thinking";
import { canMake, imageOutputWhy } from "@/lib/modality";
import { catalogueEntry } from "@/services/pricing";
import type { BackendType } from "@/types";
import type { ChatMode } from "@/types/chat";

export type ChatActionId = "web" | "think" | "image";

/** Whether one specific model can perform an action, and what to say about it.
 *  `usable` is not `verdict === "yes"`: not knowing leaves the control live
 *  and hedges in the tooltip, because a grey button that turns out to have
 *  been wrong is worse than a request the backend declines. */
export interface ModelSupport {
  usable: boolean;
  why: string;
  /** True only when the answer is looked up rather than assumed, so the
   *  composer can render a guess differently from a fact. */
  certain: boolean;
}

export interface ChatAction {
  id: ChatActionId;
  /** The chip's label in the composer. */
  label: string;
  /** Shown when it is on, and in the tooltip. Plain words, no jargon. */
  blurb: string;
  /** Said when the current backend cannot do it, so the disabled chip can
   *  explain itself instead of just being grey. */
  unsupported: string;
  /**
   * Mutate the outgoing request body. Called only when the action is enabled
   * and the backend declares support for it.
   *
   * Takes the backend id because one capability does not always have one
   * spelling: OpenRouter turns reasoning on with `reasoning: {enabled}` and
   * Ollama with `think: true`, and pushing that difference out into the
   * backends would scatter one feature across four files.
   */
  apply(body: Record<string, unknown>, backend: BackendType): void;
  /** Asked per model, when support is not a property of the backend alone.
   *  Absent means "any model this backend serves". */
  modelSupport?(model: string): ModelSupport;
}

export const CHAT_ACTIONS: Record<ChatActionId, ChatAction> = {
  web: {
    id: "web",
    label: "Web",
    blurb: "Searches the web and answers from what it finds, with sources.",
    unsupported: "Only OpenRouter can search the web. Switch backend in Settings to use this.",
    apply(body) {
      /* The plugin form rather than the `model:online` suffix: the suffix
         would have to be spliced into the model id, which then no longer
         matches the pricing catalogue or the model picker. */
      body.plugins = [...(Array.isArray(body.plugins) ? (body.plugins as unknown[]) : []), { id: "web" }];
    }
  },

  think: {
    id: "think",
    label: "Think",
    blurb: "Works the problem out before answering. Slower, and the thinking is billed as output tokens.",
    /* Groq and the generic OpenAI-compatible backend are left out on purpose,
       and it is not an oversight to be tidied up later. Groq spells this
       `reasoning_effort` and returns a 400 when the model is not a reasoning
       one, so the switch would fail loudly on most of its catalogue; the
       custom backend is whatever server you pointed it at, and there is no
       dialect to guess. Both would be dials that break rather than dials that
       work. */
    unsupported: "OpenRouter and Ollama are the two backends with a thinking switch. Change backend in Settings to use this.",
    apply(body, backend) {
      /* `enabled` rather than an effort level: effort is already a dial in
         this composer and means something else here (history, memory, reply
         length), so a Think switch that quietly set a second, differently
         scaled effort would be two controls fighting over one word. This asks
         for the model's own default depth. */
      if (backend === "ollama") body.think = true;
      else body.reasoning = { enabled: true };
    },
    modelSupport(model) {
      const s = thinkingSupport(model);
      return { usable: s.usable, why: s.why, certain: s.verdict !== "unknown" };
    }
  },

  image: {
    id: "image",
    label: "Image",
    blurb: "Lets the reply come back as a picture as well as words. Billed per image, not per token.",
    unsupported: "Only OpenRouter reaches models that draw. Change backend in Settings to use this.",
    apply(body) {
      /* Asking for both, never for image alone. A reply that is a bare picture
         with no sentence around it cannot be quoted, read aloud, turned into a
         card or searched — and the model has to be allowed to answer in words
         when what was asked for is not a picture at all. */
      body.modalities = ["image", "text"];
    },
    modelSupport(model) {
      const verdict = canMake(catalogueEntry(model)?.outputModalities, "image");
      return {
        usable: verdict !== "no",
        why: imageOutputWhy(model, verdict),
        certain: verdict !== "unknown"
      };
    }
  }
};

export const ACTION_ORDER: ChatActionId[] = ["web", "think", "image"];

/**
 * What a mode switches on by itself.
 *
 * Image mode *is* the Image action plus two dials, so the action rides along
 * without being stored on the conversation: storing it would leave the switch
 * stuck on after you left the mode, and the user never turned it on. Derived,
 * never memorised — the same rule the gap clusters follow.
 */
export function actionsFor(mode: ChatMode | undefined, actions: ChatActionId[]): ChatActionId[] {
  if (mode !== "image" || actions.includes("image")) return actions;
  return [...actions, "image"];
}

export function isActionId(v: unknown): v is ChatActionId {
  return typeof v === "string" && v in CHAT_ACTIONS;
}

/** What this backend can do. Unknown backend ids support nothing, which is
 *  the safe direction: a chip that is wrongly disabled is a nuisance, one
 *  that is wrongly enabled sends a request the backend rejects. */
export function supportedBy(supports: ChatActionId[] | undefined, id: ChatActionId): boolean {
  return !!supports && supports.includes(id);
}

/**
 * The whole question in one call: can this backend, with this model, do this?
 *
 * The composer and the send path both need the same answer, and they used to
 * be able to get away with asking the backend alone. Once one action became
 * model-dependent the two halves of the check had to travel together, or the
 * composer would offer a switch the wire silently dropped — which is the dead
 * dial wearing a different hat.
 */
export function availability(
  id: ChatActionId,
  supports: ChatActionId[] | undefined,
  model: string
): { can: boolean; certain: boolean; why: string } {
  const action = CHAT_ACTIONS[id];
  if (!supportedBy(supports, id)) return { can: false, certain: true, why: action.unsupported };
  if (!action.modelSupport) return { can: true, certain: true, why: action.blurb };
  const m = action.modelSupport(model);
  return { can: m.usable, certain: m.certain, why: m.why };
}
