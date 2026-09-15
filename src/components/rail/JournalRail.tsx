/* ============================================================================
 * JournalRail — whether the habit is actually holding, beside the entry.
 *
 * Journalling only works if it happens, and the thing that makes it happen is
 * being able to see the run of days without opening the timeline. The rest of
 * the panel is the two fields that earn their keep — what is still open, and
 * what has been logged but not yet turned into anything.
 * ========================================================================== */
import * as journalStore from "@/services/journalStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { dayKey, DAY } from "@/lib/util";
import type { JournalEntry } from "@/types/journal";
import { RailEmpty, RailFigure, RailGroup, RailItem, RailList, RailSub, RailWeek } from "./Rail";

/** Seven booleans, oldest first, ending today: was anything captured that day?
 *  Keyed off `day` rather than timestamps so it matches what the timeline
 *  shows, including an entry back-filled for an earlier date. */
function weekOfEntries(entries: JournalEntry[]): boolean[] {
  const have = new Set(entries.filter((e) => e.raw.length > 0).map((e) => e.day));
  const days: boolean[] = [];
  for (let i = 6; i >= 0; i--) days.push(have.has(dayKey(Date.now() - i * DAY)));
  return days;
}

export default function JournalRail({ projectId, onOpenDay }: { projectId: string; onOpenDay?: (day: string) => void }) {
  useStoreSync(journalStore);

  const all = journalStore.listForProject(projectId);
  /* Opening the journal calls getOrCreateToday, so an untouched day still has
     an entry. Only one with raw text in it counts as a day you logged. */
  const entries = all.filter((e) => e.raw.length > 0);
  const week = weekOfEntries(entries);
  const written = entries.filter((e) => e.summary);
  const undistilled = written.filter((e) => !e.distilled.at);
  const unrolled = journalStore.unrolledEntries(projectId);
  const weeksWaiting = journalStore.unrolledWeeks(projectId).length;

  /* Open threads, newest first and deduplicated — the same question asked on
     three days is one thing you have not resolved, not three. */
  const seen = new Set<string>();
  const open: { day: string; text: string }[] = [];
  for (const e of [...written].sort((a, b) => b.created - a.created)) {
    for (const o of e.summary!.open) {
      const k = o.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      open.push({ day: e.day, text: o });
    }
  }

  const streak = (() => {
    let n = 0;
    for (let i = 0; i < 400; i++) {
      if (!week.length) break;
      const day = dayKey(Date.now() - i * DAY);
      if (entries.some((e) => e.day === day && e.raw.length > 0)) n++;
      else if (i > 0) break;
    }
    return n;
  })();

  return (
    <>
      <RailGroup title="This week" note={streak > 0 ? `${streak} day${streak === 1 ? "" : "s"}` : undefined}>
        <RailWeek days={week} />
        <RailSub>
          {week.filter(Boolean).length === 0
            ? "nothing logged in the last seven days"
            : `${week.filter(Boolean).length} of the last seven days logged`}
        </RailSub>
      </RailGroup>

      <RailGroup title="Written up">
        <RailFigure
          value={written.length}
          unit={written.length === 1 ? "entry" : "entries"}
          muted={written.length === 0}
        />
        <RailSub>
          {entries.length > written.length
            ? `${entries.length - written.length} day${entries.length - written.length === 1 ? "" : "s"} captured but not written`
            : "every captured day has a narrative"}
        </RailSub>
      </RailGroup>

      {(undistilled.length > 0 || unrolled.length > 0) && (
        <RailGroup title="Waiting on you">
          <RailList>
            {undistilled.length > 0 && (
              <RailItem
                mark="→"
                text={`${undistilled.length} entr${undistilled.length === 1 ? "y" : "ies"} not distilled`}
              />
            )}
            {unrolled.length > 0 && (
              <RailItem
                mark="→"
                text={`${unrolled.length} not in a weekly rollup${weeksWaiting > 1 ? ` · ${weeksWaiting} weeks` : ""}`}
              />
            )}
          </RailList>
        </RailGroup>
      )}

      <RailGroup title="Still open" note={open.length > 4 ? `${open.length}` : undefined}>
        {open.length === 0 ? (
          <RailEmpty>Nothing raised and unresolved.</RailEmpty>
        ) : (
          <RailList>
            {open.slice(0, 6).map((o, i) => (
              <RailItem
                key={i}
                mark="·"
                text={o.text}
                title={`${o.text}  — from ${o.day}`}
                onClick={onOpenDay ? () => onOpenDay(o.day) : undefined}
              />
            ))}
          </RailList>
        )}
      </RailGroup>
    </>
  );
}
