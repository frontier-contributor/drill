/* ============================================================================
 * DayRecord — what the app logged for this day, above the box you type in.
 *
 * The journal used to be written from the capture box alone, which made it the
 * one section whose job is to say what happened and which could not see
 * anything that had: a day spent drilling sixty cards, arguing through a
 * derivation in chat and sitting an exam produced "Log something first".
 *
 * The same record now goes to the journal writer (lib/dayBrief.ts), so this
 * panel is not a readout beside the feature — it *is* the feature, shown. What
 * you see here is exactly what the model is given, block for block, because
 * both come from `dayBlocks` over one walk. A page that claimed a day the
 * prompt did not have would be the bug services/activity.ts exists to prevent,
 * one layer up.
 *
 * Shut by default. The point of the day is what you have to say about it; this
 * is the evidence, and evidence belongs behind a summary line.
 * ========================================================================== */
import { useMemo, useState } from "react";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useDrillStore } from "@/hooks/useDrillStore";
import * as journalStore from "@/services/journalStore";
import * as figures from "@/services/figures";
import { collectDay, dayBlocks, daySummary, dayWindow, isEmptyDay } from "@/lib/dayBrief";
import Icon from "../ui/Icon";

export default function DayRecord({ projectId, day }: { projectId: string; day: string }) {
  const db = useDrillStore();
  const journalVersion = useStoreSync(journalStore);
  const figuresVersion = useStoreSync(figures);
  const [open, setOpen] = useState(false);

  /* Rebuilt whenever any of the stores it reads moves, which is what the three
     subscriptions above are for: writing a card and coming back to the journal
     should not leave a day on screen that has stopped being true. */
  const record = useMemo(() => {
    const w = dayWindow(day);
    return w ? collectDay(projectId, w) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, day, db, journalVersion, figuresVersion]);

  if (!record || isEmptyDay(record)) return null;

  /* The journal's own entry is left out: it is rendered in full immediately
     below this panel, and a day that repeated itself twice on one screen
     would read as a bug. */
  const blocks = dayBlocks(record).filter((b) => b.kind !== "journal");
  if (!blocks.length) return null;

  const summary = daySummary(record);

  return (
    <div className={"dayrec" + (open ? " open" : "")}>
      <button className="dayrec-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="chevron" size={11} className="dayrec-chev" />
        <span className="dayrec-title">The record</span>
        <span className="dayrec-sum">{summary}</span>
      </button>
      {open && (
        <div className="dayrec-body">
          {blocks.map((b, i) => (
            <div className="dayrec-block" key={i}>
              <div className="dayrec-bh">{b.head}</div>
              {b.lines.length > 0 && <div className="dayrec-bl">{b.lines.join("\n")}</div>}
            </div>
          ))}
          <p className="dayrec-foot">
            This is what the journal writer is given, word for word, alongside anything you type below.
          </p>
        </div>
      )}
    </div>
  );
}
