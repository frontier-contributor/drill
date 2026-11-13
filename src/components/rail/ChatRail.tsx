/* ============================================================================
 * ChatRail — what the model can actually see, beside the conversation.
 *
 * The entire reason chat lives inside Drill rather than in a browser tab
 * pointed at openrouter.ai is that it can see your decks, your journal and
 * what is known about you. Until now you had to open a settings panel to find
 * out whether any of that was true for the thread in front of you.
 *
 * The memory list here is retrieved through the same function the send path
 * uses (chatContext.retrieveForSource), so it cannot drift from what actually
 * goes out — the reason that function takes an explicit projectId.
 * ========================================================================== */
import * as chatStore from "@/services/chatStore";
import { describeSource, retrieveForSource, sourceSize } from "@/lib/chatContext";
import { estimateTokens, formatCost, formatTokens } from "@/lib/tokens";
import { answerRoute } from "@/lib/answerRoute";
import { isPersonalProject } from "@/lib/migrate";
import type { Conversation } from "@/types/chat";
import { RailEmpty, RailFigure, RailGroup, RailItem, RailList, RailSub } from "./Rail";

export default function ChatRail({ conversation }: { conversation: Conversation | null }) {
  if (!conversation) {
    return (
      <RailGroup title="Context">
        <RailEmpty>Open or start a conversation to see what it can read.</RailEmpty>
      </RailGroup>
    );
  }

  const c = conversation;
  const lastUser = [...c.turns].reverse().find((t) => t.role === "user");
  const queryText = lastUser ? chatStore.activeContent(lastUser) : c.title;

  const memSource = c.context.find((s) => s.kind === "memory");
  const trace = memSource ? retrieveForSource(memSource, queryText, c.projectId) : null;

  /* Context is rebuilt at send time, so this is an estimate of the next
     message rather than a record of the last one — which is the useful
     number: it tells you what you are about to pay for. */
  const contextChars = c.context.reduce((n, s) => n + sourceSize(s, queryText, c.projectId), 0);
  const contextTokens = estimateTokens("x".repeat(contextChars));

  /* Auto and Deep can go and get what the fixed context did not bring, so
     "what it can see" is two lists now: what goes out with every message,
     and what it may look up. Saying the first is empty without the second
     would describe a Quick thread. */
  const looks = answerRoute(c.mode, c.actions) !== "single";
  const reach = isPersonalProject(c.projectId) ? "every project — " : "this project — ";

  const spent = c.usage || { promptTokens: 0, completionTokens: 0 };
  const total = (spent.promptTokens || 0) + (spent.completionTokens || 0);

  return (
    <>
      <RailGroup title="What it can see" note={c.context.length ? `~${formatTokens(contextTokens)}` : undefined}>
        {c.context.length === 0 ? (
          <>
            <RailEmpty>
              {looks
                ? "Nothing attached up front — it looks things up in your record when a question needs it."
                : "Nothing attached — this thread is a plain model that cannot see your day, your cards or your journal."}
            </RailEmpty>
            {/* Every conversation made before defaults existed has an empty
                context, and finding the settings panel to fix that is more
                than anyone should have to do to make the tutor work. */}
            <button
              className="btn sm"
              onClick={() => {
                c.context = chatStore.defaultContext();
                chatStore.persist(c, true);
              }}
            >
              Let it see your work
            </button>
          </>
        ) : (
          <RailList>
            {c.context.map((s, i) => (
              <RailItem key={i} mark="·" text={describeSource(s)} />
            ))}
          </RailList>
        )}
      </RailGroup>

      {looks && (
        <RailGroup title="Can look up">
          <RailSub>
            {reach}memory, cards and how they are going, the journal, notes, files, past chats, exams and kept figures
            {(c.actions || []).includes("web") ? ", and the web" : ""}. Only when a question needs it.
          </RailSub>
        </RailGroup>
      )}

      {memSource && (
        <RailGroup title="Memory in play" note={trace ? `${trace.picked.length}/${trace.considered.length}` : undefined}>
          {!trace || trace.picked.length === 0 ? (
            <RailEmpty>
              {trace && trace.considered.length === 0
                ? "No memory recorded for this project yet."
                : "Nothing scored high enough for this message."}
            </RailEmpty>
          ) : (
            <>
              <RailList>
                {trace.picked.map((m) => (
                  <RailItem key={m.id} mark={m.pinned ? "★" : "·"} text={m.text} title={`(${m.type}) ${m.text}`} />
                ))}
              </RailList>
              <RailSub>scored against your last message, fresh on every send</RailSub>
            </>
          )}
        </RailGroup>
      )}

      <RailGroup title="This thread">
        <RailFigure value={c.turns.length} unit={c.turns.length === 1 ? "turn" : "turns"} muted={!c.turns.length} />
        <RailSub>
          {total > 0
            ? `${formatTokens(total)} tokens used${c.usage?.cost ? ` · ${formatCost(c.usage.cost)}` : ""}`
            : "nothing sent yet"}
        </RailSub>
      </RailGroup>
    </>
  );
}
