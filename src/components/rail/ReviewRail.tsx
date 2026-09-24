/* ============================================================================
 * ReviewRail — what today looks like, beside the card.
 *
 * The review queue is endless by design, which makes progress invisible: you
 * cannot tell a good day from a bad one while you are inside it. This is the
 * readout that fixes that — the day's run, what is waiting, the streak, and
 * the cards you keep getting wrong.
 *
 * Everything here is computed live from the store (START-HERE §2.6: never
 * memorise what can be computed).
 * ========================================================================== */
import * as store from "@/services/store";
import * as activity from "@/services/activity";
import * as chatStore from "@/services/chatStore";
import * as journalStore from "@/services/journalStore";
import * as examStore from "@/services/examStore";
import * as memoryStore from "@/services/memoryStore";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useSheet } from "@/context/SheetContext";
import { useRoute } from "@/context/RouteContext";
import { requestWeakExam } from "@/lib/examIntent";
import { streaks, week as weekOf } from "@/lib/activity";
import { gapsFrom } from "@/lib/gaps";
import { stripTags } from "@/lib/util";
import { RailBar, RailEmpty, RailFigure, RailGroup, RailItem, RailList, RailSub, RailWeek } from "./Rail";

/* The week and the streak are the project's whole activity, not this rail's
   own arithmetic over db.log. Two reasons, both learned the hard way: this
   read the *unfiltered* log, so a week spent in another project lit up here;
   and it counted only graded cards, so a day of journal and chat broke a
   streak that Home said was intact. Same map, same function, same answer, in
   both places. */

/** The cards costing the most: leeches first, then most-lapsed. Same ordering
 *  the chat context uses for its "weak" source, so the rail and the tutor
 *  agree about what you are bad at. */
function worstCards(limit: number) {
  const out: { id: string; deckId: string; text: string; lapses: number }[] = [];
  for (const d of store.pool()) {
    for (const c of d.cards) {
      const st = d.srs[c.id];
      if (!st || !st.reps || !st.lapses) continue;
      out.push({ id: c.id, deckId: d.id, text: stripTags(c.q), lapses: st.lapses });
    }
  }
  out.sort((a, b) => b.lapses - a.lapses);
  return out.slice(0, limit);
}

export default function ReviewRail() {
  const db = useDrillStore();
  /* The activity map reads all four IndexedDB stores, so this has to
     re-render when any of them lands — they load after the review loop's
     first paint. */
  useStoreSync(chatStore);
  useStoreSync(journalStore);
  useStoreSync(examStore);
  useStoreSync(memoryStore);
  const { open } = useSheet();
  const { openExam } = useRoute();

  const s = store.stats();
  const counts = store.counts();
  const session = store.session();
  const days = activity.daysFor(db.activeProjectId);
  const { active: week, total: weekTotal } = weekOf(days);
  const worst = worstCards(4);
  const gaps = gapsFrom(store.logOf(store.projectDecks()), { limit: 4 });
  /* One definition of a streak, in lib/activity, over the whole project's
     activity. It was max(deck.meta.streak) — a stored per-deck counter that
     only advances for decks in pool() when rollover() runs — so it drifted
     from the one Home computed and the two disagreed on screen. */
  const streak = streaks(days).current;
  const retention = s.rev > 0 ? Math.round((s.ok / s.rev) * 100) : null;
  const target = store.settings().sessionSize || 10;

  return (
    <>
      <RailGroup title="Today" note={session ? `${session.done}/${session.target}` : undefined}>
        {session ? (
          <>
            <RailBar value={session.done} max={session.target} />
            <RailSub>
              {session.done >= session.target
                ? `Run finished — ${session.done} card${session.done === 1 ? "" : "s"}. Keep going if you like.`
                : `${session.target - session.done} to go · ${s.today} reviewed today`}
            </RailSub>
            <button className="rail-item" onClick={() => store.endSession()}>
              <span className="rail-item-mark">×</span>
              <span className="rail-item-text">End the run</span>
            </button>
          </>
        ) : (
          <>
            <RailFigure value={s.today} unit={s.today === 1 ? "card" : "cards"} muted={s.today === 0} />
            <RailSub>reviewed today, no finish line set</RailSub>
            <button className="btn sm" onClick={() => store.startSession(target)}>
              Run {target} cards
            </button>
          </>
        )}
      </RailGroup>

      <RailGroup title="Waiting">
        <RailFigure value={counts.due} unit={counts.due === 1 ? "due" : "due"} muted={counts.due === 0} />
        <RailSub>
          {counts.newLeft > 0
            ? `${counts.newLeft} new card${counts.newLeft === 1 ? "" : "s"} still allowed today`
            : counts.unseen > 0
              ? "new-card limit reached for today"
              : "every card in this project has been seen"}
        </RailSub>
      </RailGroup>

      {/* The week and the streak count everything the project had happen in
          a day, not just cards graded — same map as Home, same function — so
          the sentence under them has to say so. It read "N reviews in the
          last seven days" under a row of squares that had started lighting up
          for journal entries and conversations. */}
      <RailGroup title="Streak" note={streak > 0 ? `${streak} day${streak === 1 ? "" : "s"}` : undefined}>
        <RailWeek days={week} />
        <RailSub>
          {weekTotal === 0
            ? "nothing logged in seven days"
            : `${weekTotal} thing${weekTotal === 1 ? "" : "s"} done in the last seven days · ${s.last7} of them reviews`}
        </RailSub>
      </RailGroup>

      <RailGroup title="Retention" note="30 days">
        {retention === null ? (
          <RailEmpty>Not enough reviews yet.</RailEmpty>
        ) : (
          <>
            <RailFigure value={`${retention}%`} />
            <RailSub>
              {`against a ${Math.round(store.settings().retention * 100)}% target · ${s.rev} graded`}
            </RailSub>
          </>
        )}
      </RailGroup>

      {/* Concepts, not cards. "Keeps slipping" below counts lapses per card,
          which tells you *what* to redo; this says what you keep getting
          wrong across all of them, which is the thing worth actually going
          and learning. Same clustering the tutor, the card writer and the
          exam generator are now given — so what the app tells you and what it
          tells the model are one answer. */}
      <RailGroup title="What you keep missing">
        {gaps.length === 0 ? (
          <RailEmpty>
            Nothing recurring yet. Turn on AI marking in Settings and this fills in as you write answers.
          </RailEmpty>
        ) : (
          <>
            <RailList>
              {gaps.map((g) => (
                <RailItem key={g.text} mark={`${g.n}×`} text={g.text} />
              ))}
            </RailList>
            <RailSub>
              <button
                className="textlink"
                onClick={() => {
                  requestWeakExam();
                  openExam(null);
                }}
              >
                Examine me on these
              </button>
            </RailSub>
          </>
        )}
      </RailGroup>

      <RailGroup title="Keeps slipping">
        {worst.length === 0 ? (
          <RailEmpty>Nothing has lapsed yet.</RailEmpty>
        ) : (
          <RailList>
            {worst.map((w) => (
              <RailItem
                key={w.id}
                mark={`${w.lapses}×`}
                text={w.text}
                onClick={() => open({ name: "editor", deckId: w.deckId, cardId: w.id })}
              />
            ))}
          </RailList>
        )}
      </RailGroup>
    </>
  );
}
