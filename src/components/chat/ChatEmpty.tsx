/* ============================================================================
 * ChatEmpty — what you see before the first message.
 *
 * Set the way every companion app has taught people to expect a new chat: a
 * greeting, one line that shows it knows where you are, the box to type in —
 * in the middle of the page, not pinned to its foot — and a few things worth
 * asking under it. The box moving to the bottom once a conversation exists is
 * the signal that you are now *in* one.
 *
 * The starters are not decoration. A blank box invites "explain transformers"
 * and gets you a Wikipedia paragraph; these seed the questions that are
 * actually worth the tokens, and most of them only exist because the app
 * knows your record. They are shaped for Auto: "what should I work on today"
 * is a question the assistant now goes and answers by looking, so it no
 * longer needs a context source switched on in advance to be answerable.
 *
 * The first of them is the day itself, and it appears only on a day that has
 * one: what the app can see you have already done is the most specific thing
 * it will ever be able to open with. The deck-shaped ones appear only where
 * there are decks — "Work on my weak spots · 0 leeches" is not a starter, it
 * is an advertisement for an empty room.
 *
 * Under them, the threads you were last in. A companion is something you
 * come back to, and the most likely next message is the one that continues
 * yesterday's conversation rather than starting a new one.
 * ========================================================================== */
import type { ReactNode } from "react";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import { isPersonalProject, list as listProjects } from "@/services/projects";
import { ASK_ABOUT_TODAY, collectDay, daySummary, isEmptyDay, todayWindow } from "@/lib/dayBrief";
import { useRoute } from "@/context/RouteContext";
import { useSettings } from "@/context/SettingsContext";
import { ago } from "@/lib/util";
import type { CreateOpts } from "@/services/chatStore";
import Icon, { type IconName } from "../ui/Icon";

interface Props {
  ready: { ok: boolean; why?: string };
  onStart: (prompt: string, opts?: CreateOpts) => void;
  onPrefill: (text: string) => void;
  /** The composer, set in the middle of the page rather than at its foot.
   *  Absent while a drawing or filming surface owns the composer slot — those
   *  keep their own place at the bottom. */
  composer?: ReactNode;
}

interface Starter {
  t: string;
  /** A number worth seeing before you press — what is due, what is failing. */
  n?: string;
  icon: IconName;
  go: () => void;
}

/** Morning, afternoon or evening, by the clock of the person reading it. */
function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function ChatEmpty({ ready, onStart, onPrefill, composer }: Props) {
  const { openChat } = useRoute();
  const settings = useSettings();
  const projectId = store.get().activeProjectId;
  const personal = isPersonalProject(projectId);

  /* The numbers on the starters describe what they will look at. Inside a
     project that is the project's own decks — not pool(), or the label would
     disagree with the thing it labelled the moment mixing was off. From the
     personal space it is every project, because that is what Auto searches
     from there. */
  const bodies = listProjects().filter((p) => !p.archived);
  const decks = personal ? bodies.flatMap((p) => store.decksOf(p.id)) : store.decksOf(projectId);
  const counts = store.counts(decks);
  const stats = store.stats(decks);

  const day = collectDay(projectId, todayWindow(1));
  const hasDay = !isEmptyDay(day);

  /* One line that shows it knows where you are. Never a promise it cannot
     keep: a fresh install says what the box can do, not what it has seen. */
  const line = !ready.ok
    ? ready.why || "Set up a model to start."
    : hasDay
      ? `Today so far: ${daySummary(day)}.`
      : counts.due > 0
        ? `${counts.due} card${counts.due === 1 ? "" : "s"} due${personal && bodies.length > 1 ? ` across ${bodies.length} projects` : ""}. Ask anything — or bring in a chat, card or exam with @.`
        : "Ask anything — or bring in a chat, card or exam with @.";

  const starters: Starter[] = [];
  if (hasDay) {
    starters.push({
      t: "Pick up where I left off",
      icon: "home",
      go: () => onStart(ASK_ABOUT_TODAY, { title: "Today" })
    });
  }
  if (personal && bodies.length) {
    starters.push({
      t: "What should I work on today?",
      icon: "sparkle",
      go: () =>
        onStart(
          "Look across my projects and tell me what I should work on today, and why — what is due, what I keep " +
            "getting wrong, and anything I left open. Keep it to the two or three things that matter most.",
          { title: "Today's plan" }
        )
    });
  }
  if (decks.length && counts.due > 0) {
    starters.push({
      t: "Quiz me on what's due",
      n: String(counts.due),
      icon: "exam",
      go: () =>
        onStart(
          "Quiz me on the cards that are due right now. Ask one question at a time, wait for my answer, then " +
            "tell me what I missed before moving on. Do not show me the answer until I have attempted it.",
          { title: "Quiz session", personaId: "socratic", context: [{ kind: "due", deckId: null }] }
        )
    });
  }
  if (decks.length && stats.leech > 0) {
    starters.push({
      t: "Work on my weak spots",
      n: String(stats.leech),
      icon: "cards",
      go: () =>
        onStart(
          "Look at the cards I keep failing. Find what they have in common — the underlying idea I have not " +
            "actually understood — and teach me that, rather than going through the cards one by one.",
          { title: "Weak spots", personaId: "tutor", context: [{ kind: "weak", deckId: null }] }
        )
    });
  }
  starters.push(
    {
      t: "Explain something new",
      icon: "bubble",
      go: () => onPrefill("Explain ")
    },
    {
      t: "Check my understanding",
      icon: "journal",
      go: () =>
        onStart("I am going to explain a concept to you in my own words. Ask me which one, then pick it apart.", {
          title: "Feynman check",
          personaId: "feynman"
        })
    },
    {
      t: "Debug some code",
      icon: "pencil",
      go: () => onStart("I have a bug. Ask me for the code and the error.", { title: "Debugging", personaId: "code" })
    }
  );

  /* The threads you were last in, here. Three: enough to be the obvious
     next step, few enough not to become a second sidebar. */
  const recent = chatStore
    .list()
    .filter((m) => m.projectId === projectId && !m.archived && m.turnCount > 0)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 3);

  return (
    <div className="chat-home">
      <div className="chat-home-inner">
        <h1 className="chat-hello">{greeting()}</h1>
        <p className={"chat-hello-sub" + (ready.ok ? "" : " warn")}>{line}</p>
        {!ready.ok && (
          <div className="chat-hello-setup">
            <button className="btn pri" onClick={() => settings.open("connection")}>
              Set up a model
            </button>
          </div>
        )}

        {composer}

        {ready.ok && (
          <div className="chat-chips" role="list">
            {starters.slice(0, 6).map((s) => (
              <button key={s.t} role="listitem" className="chip-starter" onClick={s.go}>
                <Icon name={s.icon} size={14} />
                <span>{s.t}</span>
                {s.n && <span className="n">{s.n}</span>}
              </button>
            ))}
          </div>
        )}

        {recent.length > 0 && (
          <div className="chat-recent">
            <div className="chat-recent-head">Continue</div>
            {recent.map((m) => (
              <button key={m.id} className="chat-recent-row" onClick={() => openChat(m.id)}>
                <Icon name="bubble" size={13} />
                <span className="t">{m.title}</span>
                <span className="w">{ago(m.updated)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
