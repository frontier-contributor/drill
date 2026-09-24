/* ============================================================================
 * ScopeBuilder — date phrase or picker, deck/tag filters, resolved locally
 * before any call is spent: "14–20 March · 4 entries · 23 cards" is visible
 * the instant you finish typing (see lib/examScope.ts, lib/when.ts).
 *
 * Two aims. The first is a subject or a stretch of time. The second is "what
 * I keep getting wrong": the confusions the marker has recorded more than
 * once, in Review and in earlier exams, and the cards they happened on. The
 * list is shown before anything is spent, for the same reason the counts are
 * — you should see what the exam is about to be about.
 * ========================================================================== */
import { useEffect, useMemo, useState } from "react";
import * as store from "@/services/store";
import * as AI from "@/services/ai";
import * as examStore from "@/services/examStore";
import { resolveScope } from "@/lib/examScope";
import { clearAim, peekAim } from "@/lib/examIntent";
import { useToast } from "@/context/ToastContext";
import type { Difficulty } from "@/types/exam";

const LEVELS: Difficulty[] = ["recall", "apply", "analyse", "synthesise"];
const LEVEL_HINT: Record<Difficulty, string> = {
  recall: "mostly single-fact questions",
  apply: "use it on a new case",
  analyse: "connect and derive across sources",
  synthesise: "the hardest mix, heaviest on connect/derive"
};

type Aim = "scope" | "weak";

export default function ScopeBuilder({ projectId, onCreated }: { projectId: string; onCreated: (examId: string) => void }) {
  const toast = useToast();
  /* Arriving from the review rail's "Examine me on these" opens on the
     weak-spots aim; the note is cleared once it has been read. */
  const [aim, setAim] = useState<Aim>(() => peekAim() ?? "scope");
  useEffect(clearAim, []);
  const [topic, setTopic] = useState("");
  const [when, setWhen] = useState("");
  const [deckIds, setDeckIds] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  const [level, setLevel] = useState<Difficulty>("apply");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decks = store.decksOf(projectId);
  const tagList = useMemo(() => tags.split(",").map((t) => t.trim()).filter(Boolean), [tags]);
  const topicTrimmed = topic.trim();
  const weak = aim === "weak";
  const resolved = useMemo(
    () => resolveScope({ projectId, when, deckIds, tags: tagList, topic: topicTrimmed, focus: weak ? "weak" : undefined }),
    [projectId, when, deckIds, tagList, topicTrimmed, weak]
  );
  /* How many recurring mistakes there are to aim at, whatever the filters
     say: the offer to switch aims should not vanish because a tag is set. */
  const onRecord = useMemo(
    () => (weak ? 0 : resolveScope({ projectId, when: "", deckIds: [], tags: [], focus: "weak" }).counts.gaps),
    [projectId, weak]
  );
  const nothingForTopic = !!topicTrimmed && !resolved.counts.entries && !resolved.counts.cards;

  function toggleDeck(id: string) {
    setDeckIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function generate() {
    if (!resolved.counts.entries && !resolved.counts.cards) {
      toast(
        weak ? "Nothing to aim at yet" : nothingForTopic ? `Nothing about "${topicTrimmed}" yet` : "Nothing matches this scope yet"
      );
      return;
    }
    setBusy(true);
    setError(null);
    AI.generateExam(resolved.material, level, [], topicTrimmed || undefined, resolved.scope.gaps)
      .then((questions) => {
        const title = resolved.scope.label + (!topicTrimmed && tagList.length ? ` · ${tagList.join(", ")}` : "");
        const exam = examStore.create({ projectId, title, scope: resolved.scope, level, questions });
        onCreated(exam.id);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }

  return (
    <div>
      <label className="f">Aim at</label>
      <div className="seg">
        <button className={aim === "scope" ? "on" : ""} onClick={() => setAim("scope")}>
          A subject or a stretch of time
        </button>
        <button className={aim === "weak" ? "on" : ""} onClick={() => setAim("weak")}>
          What I keep getting wrong
        </button>
      </div>
      {!weak && onRecord >= 2 && (
        <div className="hintline">
          You have {onRecord} recurring mistakes on record.{" "}
          <button className="textlink" onClick={() => setAim("weak")}>
            Aim an exam at them
          </button>
          .
        </div>
      )}

      {weak && (
        <div className="weak-aim">
          {resolved.gaps.length > 0 ? (
            <>
              <p className="hintline">
                Recorded more than once when your answers were marked — in Review and in earlier exams. Every question
                will test one of these, from a different angle than the card that caught it.
              </p>
              <ul className="weak-list">
                {resolved.gaps.map((g) => (
                  <li key={g.text}>
                    <span className="weak-t">{g.text}</span>
                    <span className="weak-n">
                      missed {g.n}×{g.cards > 1 ? ` · ${g.cards} cards` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : resolved.counts.cards > 0 ? (
            <p className="hintline">
              No mistake has been recorded twice yet, so this aims at your weakest cards instead — the leeches and the
              ones you keep forgetting. Typing an answer in Review before revealing it is what records the rest.
            </p>
          ) : (
            <p className="hintline">
              Nothing to aim at yet. Mistakes are recorded when you type an answer in Review before revealing it and it
              is marked, and when an exam is graded. A few days of that and this fills itself.
            </p>
          )}
        </div>
      )}

      <label className="f">{weak ? "Topic — optional, to narrow the mistakes to one subject" : 'Topic — what to target, e.g. "matplotlib", "gradient descent", "the chain rule"'}</label>
      <input
        className="fi"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder={weak ? "leave blank for every subject" : "leave blank to use decks/tags below instead"}
      />
      {!weak && (
        <div className="hintline">
          {topicTrimmed
            ? "Searches every card and journal entry in this project for what matches — not just what is in the decks below."
            : "Naming a topic finds relevant material across the whole project by itself; decks and tags below are for scoping by hand instead."}
        </div>
      )}

      <label className="f" style={{ marginTop: 14 }}>
        When — "last week", "this month", a date, or leave blank for everything
      </label>
      <input className="fi" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. last week, 3 days ago, march" />
      {when.trim() && resolved.unparsed && <div className="hintline">Could not parse that — showing everything below instead.</div>}

      {decks.length > 0 && (
        <>
          <label className="f">Decks — none selected means every deck in this project</label>
          <div className="list" style={{ marginBottom: 14 }}>
            {decks.map((d) => (
              <button key={d.id} className={"item" + (deckIds.includes(d.id) ? " on" : "")} onClick={() => toggleDeck(d.id)}>
                <span className="grow">
                  <span className="t">{d.name}</span>
                  <span className="s">{d.cards.length} cards</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <label className="f">Tags — comma-separated, optional</label>
      <input className="fi" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. Backprop, Notation" />

      <label className="f">Difficulty</label>
      <div className="seg" style={{ marginBottom: 6 }}>
        {LEVELS.map((l) => (
          <button key={l} className={level === l ? "on" : ""} onClick={() => setLevel(l)}>
            {l}
          </button>
        ))}
      </div>
      <div className="hintline">{LEVEL_HINT[level]}</div>

      <div className="exam-counts">
        {nothingForTopic
          ? `Nothing about "${topicTrimmed}" found yet — write a few cards or a journal entry mentioning it first, or broaden the topic.`
          : `${weak ? `${resolved.counts.gaps} recurring mistake${resolved.counts.gaps === 1 ? "" : "s"} · ` : ""}${resolved.counts.entries} journal ${resolved.counts.entries === 1 ? "entry" : "entries"} · ${resolved.counts.cards} cards · ${resolved.scope.label}`}
      </div>

      {error && <div className="err">{error}</div>}
      <button className="btn pri wide" disabled={busy} onClick={generate}>
        {busy ? "Building the exam…" : "Generate exam"}
      </button>
    </div>
  );
}
