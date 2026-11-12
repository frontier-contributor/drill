/* ============================================================================
 * chatCtx — the chat context object and its two hooks, and nothing else.
 *
 * Split from ChatContext.tsx so that asking "am I inside chat?" does not cost
 * the whole of chat. The provider imports the agent loop, drawing, video and
 * the file wire; Settings only needs useMaybeChat(), and while both lived in
 * one module every importer of the hook dragged the provider with it — which
 * is how all of that ended up in the bundle the review loop starts from.
 *
 * The import below is type-only on purpose, and must stay that way: it is
 * erased at build time, so this module has no runtime dependency on the
 * provider. A value import here puts the provider back in the entry chunk,
 * and the budget in vite.config.ts will say so.
 * ========================================================================== */
import { createContext, useContext } from "react";
import type { ChatState } from "./ChatContext";

export const ChatCtx = createContext<ChatState | null>(null);

export function useChat(): ChatState {
  const ctx = useContext(ChatCtx);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

/** Settings is one surface opened from every section, and one of its
 *  categories — "This chat" — is only meaningful inside chat. This is how it
 *  asks whether it is there, rather than being offered in every view and
 *  throwing in five of them. */
export function useMaybeChat(): ChatState | null {
  return useContext(ChatCtx);
}
