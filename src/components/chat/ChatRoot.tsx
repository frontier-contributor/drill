/* ============================================================================
 * ChatRoot — chat's provider and chat's view, as one lazy unit.
 *
 * The provider used to be mounted eagerly from App with only the view behind
 * React.lazy. That kept KaTeX out of the review loop's bundle and let
 * everything the provider imports straight in: the agent loop and its tools,
 * drawing, video, the file wire. Nothing outside chat reads any of it, so it
 * loads with chat now.
 * ========================================================================== */
import { ChatProvider } from "@/context/ChatContext";
import ChatView from "./ChatView";

export default function ChatRoot() {
  return (
    <ChatProvider>
      <ChatView />
    </ChatProvider>
  );
}
