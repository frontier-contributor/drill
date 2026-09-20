/* ============================================================================
 * ChatEmpty — what you see before the first message.
 *
 * The starters are not decoration. A blank box invites "explain transformers"
 * and gets you a Wikipedia paragraph; these seed the modes that are actually
 * worth the tokens, and three of the six only exist because the app knows
 * your decks.
 *
 * The first of them is the day itself, and it appears only on a day that has
 * one: what the app can see you have already done is the most specific thing
 * it will ever be able to open with, and it is also how anyone finds out that
 * chat can see it at all.
 *
 * Which is exactly why the personal space gets a different set. "Work on my
 * weak spots · 0 leeches" is not a starter there, it is an advertisement for
 * an empty room — Personal has no decks by design, and offering the three
 * deck-shaped openers would be the app promising something it cannot do. The
 * headline promise changes with it, for the same reason: a fresh personal
 * chat cannot see decks or weak cards, and saying it can would be the first
 * thing it got wrong.
 * ========================================================================== */
import * as store from "@/services/store";
import { isPersonalProject } from "@/services/projects";
import { ASK_ABOUT_TODAY, collectDay, daySummary, isEmptyDay, todayWindow } from "@/lib/dayBrief";
import type { CreateOpts } from "@/services/chatStore";
import Icon, { type IconName } from "../ui/Icon";

interface Props {
  ready: { ok: boolean; why?: string };
  onStart: (prompt: string, opts?: CreateOpts) => void;
  onPrefill: (text: string) => void;
}

export default function ChatEmpty({ ready, onStart, onPrefill }: Props) {
  /* The project's decks, not pool(). These numbers describe what the starter
     beside them will attach, and the sources it attaches are project-scoped —
     so reading them off the active deck made the label disagree with the
     thing it labelled the moment mixing was off. */
  const projectDecks = store.decksOf(store.get().activeProjectId);
  const counts = store.counts(projectDecks);
  const stats = store.stats(projectDecks);
  const personal = isPersonalProject(store.get().activeProjectId);

  /* The day, if there is one. Offered first when there is and not at all when
     there is not — the same rule the deck starters follow, for the same
     reason: a starter that promises to pick up where you left off, on a day
     you have not started, is an advertisement for an empty room. */
  const day = collectDay(store.get().activeProjectId, todayWindow(1));
  const dayStarter = isEmptyDay(day)
    ? []
    : [
        {
          t: "Pick up where I left off",
          s: daySummary(day),
          icon: "home" as IconName,
          go: () => onStart(ASK_ABOUT_TODAY, { title: "Today", personaId: "tutor" })
        }
      ];

  const deckStarters: { t: string; s: string; icon: IconName; go: () => void }[] = [
    {
      t: "Work on my weak spots",
      s: `${stats.leech} leech${stats.leech === 1 ? "" : "es"} · finds what they have in common instead of drilling them`,
      icon: "cards",
      go: () =>
        onStart(
          "Look at the cards I keep failing. Find what they have in common — the underlying idea I have not " +
            "actually understood — and teach me that, rather than going through the cards one by one.",
          { title: "Weak spots", personaId: "tutor", context: [{ kind: "weak", deckId: null }] }
        )
    },
    {
      t: "Quiz me on what's due",
      s: `${counts.due} due · one question at a time, marks each answer`,
      icon: "exam",
      go: () =>
        onStart(
          "Quiz me on the cards that are due right now. Ask one question at a time, wait for my answer, then " +
            "tell me what I missed before moving on. Do not show me the answer until I have attempted it.",
          { title: "Quiz session", personaId: "socratic", context: [{ kind: "due", deckId: null }] }
        )
    },
  ];

  const always: { t: string; s: string; icon: IconName; go: () => void }[] = [
    {
      t: "Explain something new",
      s: "From first principles, with a worked example",
      icon: "sparkle",
      go: () => onPrefill("Explain ")
    },
    {
      t: "Check my understanding",
      s: "You explain it, the model finds the holes",
      icon: "journal",
      go: () =>
        onStart("I am going to explain a concept to you in my own words. Ask me which one, then pick it apart.", {
          title: "Feynman check",
          personaId: "feynman"
        })
    },
    {
      t: "Dig into a paper or my notes",
      s: "Paste or attach text, then interrogate it",
      icon: "paperclip",
      go: () => onPrefill("Here are my notes. Pull out what is worth remembering and what I have glossed over:\n\n")
    },
    {
      t: "Debug some code",
      s: "Shape-aware, names the failing input first",
      icon: "pencil",
      go: () => onStart("I have a bug. Ask me for the code and the error.", { title: "Debugging", personaId: "code" })
    }
  ];

  /* Deck-shaped openers first where there are decks, and not at all where
     there are none. */
  const starters = personal ? [...dayStarter, ...always] : [...dayStarter, ...deckStarters, ...always];

  return (
    <div className="chat-empty">
      <div className="chat-empty-icon">
        <Icon name="bubble" size={28} />
      </div>
      <h2>{personal ? "What's on your mind?" : "What are we working on?"}</h2>
      <p>
        {!ready.ok
          ? ready.why
          : personal
            ? "A chat that belongs to nothing. Nothing here is filed against a project — and anything it tells you can still become flashcards in one click."
            : "This chat can see your decks, your weak cards and your insight log — and anything it tells you can become flashcards in one click."}
      </p>
      <div className="starters">
        {starters.map((s) => (
          <button key={s.t} className="starter" onClick={s.go} disabled={!ready.ok}>
            <div className="starter-icon">
              <Icon name={s.icon} size={16} />
            </div>
            <div className="starter-content">
              <span className="t">{s.t}</span>
              <span className="s">{s.s}</span>
            </div>
            <Icon name="send" size={12} className="starter-arrow" />
          </button>
        ))}
      </div>
    </div>
  );
}
