/* ============================================================================
 * TodayStrip — what you have done today, in every section, as one line.
 *
 * The app could tell you how many cards you had graded and nothing else. Every
 * other thing you might spend an evening on — writing the journal, working a
 * conversation, sitting an exam, turning answers into cards — happened in a
 * section that reported only on itself, so there was no screen anywhere that
 * answered "what did I actually do today".
 *
 * This is that screen, and it is one row. Each tile is a real count from a
 * real store and a door into the section that produced it, so the answer to
 * "3 journal entries?" is one click rather than a hunt. Kinds with nothing in
 * them are left out — a row of zeroes reads as a scoreboard you are losing,
 * and this is a record, not a score.
 * ========================================================================== */
import { ACTIVITY_KINDS, KIND_LABEL, type ActivityKind, type DayActivity } from "@/lib/activity";
import { useRoute } from "@/context/RouteContext";
import { useSettings } from "@/context/SettingsContext";

export default function TodayStrip({ day }: { day: DayActivity }) {
  const { openDrill, openCards, openChat, openJournal, openExam, openFigures } = useRoute();
  const settings = useSettings();

  /* Every tile goes somewhere true. Notes land on Cards because that is the
     library of things you have written down; memory is a settings page rather
     than a section, and saying so by opening it is better than a tile that
     does nothing. */
  const go: Record<ActivityKind, () => void> = {
    review: openDrill,
    card: openCards,
    note: openCards,
    journal: () => openJournal(),
    chat: () => openChat(null),
    exam: () => openExam(null),
    memory: () => settings.open("memory", "memory.store"),
    figure: () => openFigures(null)
  };

  const done = ACTIVITY_KINDS.filter((k) => day.by[k] > 0);

  if (!done.length) {
    return (
      <div className="today today-none">
        <span className="today-label">Today</span>
        <p>
          Nothing logged yet. A card graded, a line in the journal, a question asked — anything at all keeps the
          day on the calendar.
        </p>
      </div>
    );
  }

  return (
    <div className="today">
      <span className="today-label">Today</span>
      <div className="today-tiles">
        {done.map((kind) => {
          const n = day.by[kind];
          const [one, many] = KIND_LABEL[kind];
          return (
            <button key={kind} className="today-tile" onClick={go[kind]}>
              <span className="today-n">{n.toLocaleString()}</span>
              <span className="today-what">{n === 1 ? one : many}</span>
            </button>
          );
        })}
      </div>
      <span className="today-total">
        {day.total.toLocaleString()} thing{day.total === 1 ? "" : "s"} so far
      </span>
    </div>
  );
}
