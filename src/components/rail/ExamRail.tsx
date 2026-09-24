/* ============================================================================
 * ExamRail — what the exams have actually told you, beside the exam.
 *
 * A single score is close to meaningless; the run of them, and the phrases
 * that keep coming back in `missing`, are the signal. That aggregation is the
 * one thing an exam list cannot show you and this panel can.
 * ========================================================================== */
import * as examStore from "@/services/examStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { ago } from "@/lib/util";
import { gapsFrom } from "@/lib/gaps";
import { examMisses } from "@/lib/examScope";
import type { Exam } from "@/types/exam";
import { RailEmpty, RailFigure, RailGroup, RailItem, RailList, RailSub } from "./Rail";

/** Percent of answered questions marked "got". Partial credit deliberately
 *  does not count: the exam exists to find what you cannot produce. */
function scoreOf(e: Exam): { pct: number; answered: number } | null {
  const answered = e.questions.filter((q) => q.result);
  if (!answered.length) return null;
  const got = answered.filter((q) => q.result!.verdict === "got").length;
  return { pct: Math.round((got / answered.length) * 100), answered: answered.length };
}

/** The phrases the marker kept writing down, clustered the way review
 *  mistakes are (lib/gaps.ts). This counted exact lowercase strings until
 *  2026-09-24, which put "chain rule ordering" and "the ordering in the chain
 *  rule" in two buckets, and disagreed with the review rail and the weak-spots
 *  exam about what a recurring mistake even was. A year, not a month: exams
 *  are rare, and one from last spring still says something. */
function recurringGaps(projectId: string, limit: number): { text: string; n: number }[] {
  return gapsFrom(examMisses(projectId), { days: 365, limit, minCount: 1 });
}

export default function ExamRail({ projectId, onOpen }: { projectId: string; onOpen?: (id: string) => void }) {
  useStoreSync(examStore);

  const exams = examStore.listForProject(projectId);
  const sat = exams.filter((e) => scoreOf(e));
  const gaps = recurringGaps(projectId, 5);
  const last = sat[0] ? scoreOf(sat[0]) : null;

  /* Average across the last five sat, so one bad morning does not read as a
     trend and one good one does not read as mastery. */
  const recent = sat.slice(0, 5).map((e) => scoreOf(e)!.pct);
  const avg = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null;

  return (
    <>
      <RailGroup title="Last score" note={sat[0] ? ago(sat[0].created) : undefined}>
        {!last ? (
          <>
            <RailFigure value="—" muted />
            <RailSub>no exam has been sat yet</RailSub>
          </>
        ) : (
          <>
            <RailFigure value={`${last.pct}%`} />
            <RailSub>
              {`${last.answered} question${last.answered === 1 ? "" : "s"} marked`}
              {avg !== null && recent.length > 1 ? ` · ${avg}% over the last ${recent.length}` : ""}
            </RailSub>
          </>
        )}
      </RailGroup>

      <RailGroup title="Sat">
        <RailFigure value={sat.length} unit={sat.length === 1 ? "exam" : "exams"} muted={sat.length === 0} />
        <RailSub>
          {exams.length > sat.length
            ? `${exams.length - sat.length} generated but not started`
            : "nothing waiting to be taken"}
        </RailSub>
      </RailGroup>

      <RailGroup title="Keeps coming up">
        {gaps.length === 0 ? (
          <RailEmpty>Nothing marked missing yet.</RailEmpty>
        ) : (
          <RailList>
            {gaps.map((g) => (
              <RailItem key={g.text} mark={g.n > 1 ? `${g.n}×` : "·"} text={g.text} />
            ))}
          </RailList>
        )}
      </RailGroup>

      {exams.length > 0 && (
        <RailGroup title="Recent">
          <RailList>
            {exams.slice(0, 6).map((e) => {
              const s = scoreOf(e);
              return (
                <RailItem
                  key={e.id}
                  mark={s ? `${s.pct}%` : "—"}
                  text={e.title}
                  title={`${e.title} · ${ago(e.created)}`}
                  onClick={onOpen ? () => onOpen(e.id) : undefined}
                />
              );
            })}
          </RailList>
        </RailGroup>
      )}
    </>
  );
}
