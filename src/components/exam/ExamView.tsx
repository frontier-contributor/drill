/* ============================================================================
 * ExamView — the top-level exam page: past exams, the scope builder for a
 * new one, and taking/reporting on whichever exam the route points at.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as examStore from "@/services/examStore";
import * as AI from "@/services/ai";
import { materialFromScope } from "@/lib/examScope";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useRoute } from "@/context/RouteContext";
import { useToast } from "@/context/ToastContext";
import Shell from "../Shell";
import ExamRail from "../rail/ExamRail";
import ScopeBuilder from "./ScopeBuilder";
import TakeExam from "./TakeExam";
import ExamReport from "./ExamReport";
import type { Difficulty, Exam } from "@/types/exam";
import "@/styles/views.css";
import Working from "../ui/Working";

function ExamDetail({
  exam,
  extendBusy,
  onExtend,
  onBack
}: {
  exam: Exam;
  extendBusy: boolean;
  onExtend: (level?: Difficulty) => void;
  onBack: () => void;
}) {
  const [showReport, setShowReport] = useState(exam.finishedAt != null);

  useEffect(() => {
    if (exam.finishedAt == null) setShowReport(false);
  }, [exam.finishedAt]);

  return (
    <>
      <div className="jrnl-head">
        <h2>{exam.title}</h2>
        <button className="btn sm" onClick={onBack}>
          All exams
        </button>
      </div>
      {extendBusy && (
        <div className="empty">
          <Working stages={["reading the scope", "choosing what to ask", "writing the questions", "making sure none of them can be guessed"]} />
        </div>
      )}
      {!extendBusy &&
        (showReport ? (
          <ExamReport exam={exam} onExtend={onExtend} />
        ) : (
          <TakeExam key={exam.id} exam={exam} onDone={() => setShowReport(true)} />
        ))}
    </>
  );
}

export default function ExamView() {
  useDrillStore();
  useStoreSync(examStore);
  const { projectId, examId, openExam } = useRoute();
  const toast = useToast();
  const [extendBusy, setExtendBusy] = useState(false);

  useEffect(() => {
    void examStore.init();
  }, []);

  const exams = examStore.listForProject(projectId);
  const exam = examId ? examStore.get(examId) : null;

  function extend(target: Exam, level?: Difficulty) {
    setExtendBusy(true);
    const material = materialFromScope(target.scope);
    const exclude = target.questions.map((q) => q.prompt);
    AI.generateExam(material, level || target.level, exclude, target.scope.topic, target.scope.gaps)
      .then((qs) => {
        examStore.addQuestions(target, qs);
        toast(`${qs.length} more question${qs.length === 1 ? "" : "s"} added`);
      })
      .catch((e: Error) => toast(e.message, 5000))
      .finally(() => setExtendBusy(false));
  }

  return (
    <Shell current="exam" aside={<ExamRail projectId={projectId} onOpen={(id) => openExam(id)} />} asideLabel="Exams">
      <div className="app-scroll">
        <div className="page">
          {!examId ? (
            <>
              <div className="page-eyebrow">
                {exams.length ? `${exams.length} past exam${exams.length === 1 ? "" : "s"}` : "Nothing sat yet"}
              </div>
              <div className="jrnl-head">
                <h2>New exam</h2>
              </div>
              <ScopeBuilder projectId={projectId} onCreated={(id) => openExam(id)} />
              {exams.length > 0 && (
                <>
                  <label className="f" style={{ marginTop: 26 }}>
                    Past exams
                  </label>
                  <div className="list">
                    {exams.map((e) => {
                      const answered = e.questions.filter((q) => q.result).length;
                      return (
                        <button key={e.id} className="item" onClick={() => openExam(e.id)}>
                          <span className="grow">
                            <span className="t">{e.title}</span>
                            <span className="s">
                              {e.questions.length} question{e.questions.length === 1 ? "" : "s"} ·{" "}
                              {e.finishedAt ? "graded" : `${answered}/${e.questions.length} answered`} · {new Date(e.created).toLocaleDateString()}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          ) : !exam ? (
            <div className="empty">
              That exam is gone.{" "}
              <button className="linkbtn" onClick={() => openExam(null)}>
                Back to exams
              </button>
            </div>
          ) : (
            <ExamDetail key={exam.id} exam={exam} extendBusy={extendBusy} onExtend={(lvl) => extend(exam, lvl)} onBack={() => openExam(null)} />
          )}
        </div>
      </div>
    </Shell>
  );
}
