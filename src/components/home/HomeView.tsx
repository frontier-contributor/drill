/* ============================================================================
 * HomeView — where a session starts and ends.
 *
 * Every other section is a place to do one thing. This is the only page that
 * answers "how is this going": the year of days, the streak, what is waiting,
 * how far through each deck you are, and what you last touched in every
 * section.
 *
 * It opens the way a front page should — a greeting set in the reading face,
 * one clear thing to do next, and everything else quiet underneath it.
 * Nothing here is a control surface for learning; every tile is a door into
 * the section that owns the work.
 *
 * All of it is derived at render time from the stores (START-HERE §2.6),
 * scoped to the active project the same way everything else is.
 * ========================================================================== */
import { useEffect, type ReactNode } from "react";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import * as journalStore from "@/services/journalStore";
import * as examStore from "@/services/examStore";
import * as memoryStore from "@/services/memoryStore";
import * as activity from "@/services/activity";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useRoute } from "@/context/RouteContext";
import { streaks, today as todayOf, week as weekOf } from "@/lib/activity";
import { ago } from "@/lib/util";
import Shell from "../Shell";
import Icon from "../ui/Icon";
import ActivityGrid from "./ActivityGrid";
import TodayStrip from "./TodayStrip";
import HomeRail from "../rail/HomeRail";
import BackupNudge from "./BackupNudge";
import "@/styles/home.css";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** A number and what it is. No box around it — the figure is the thing and
 *  the label is its caption; a border would only add a rectangle. */
function Figure({
  value,
  label,
  note,
  tone
}: {
  value: string | number;
  label: string;
  note?: string;
  tone?: "accent" | "green" | "muted";
}) {
  return (
    <div className={"home-fig" + (tone ? " " + tone : "")}>
      <div className="home-fig-n">{value}</div>
      <div className="home-fig-l">{label}</div>
      {note && <div className="home-fig-note">{note}</div>}
    </div>
  );
}

/** Sentence-case subhead in the reading face, with an optional quiet note on
 *  the right. Deliberately not the uppercase mono label the panes use: this
 *  page is read, not operated. */
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="home-sec">
      <h3 className="home-sec-h">
        <span>{title}</span>
        {note && <span className="home-sec-note">{note}</span>}
      </h3>
      {children}
    </section>
  );
}

/** One line of the table of contents: the section, a dot leader, and what is
 *  waiting in it. A book's contents page is the most inviting page it has —
 *  it is a list of places you could go — so the sections are set as one. */
function Entry({ label, note, onClick }: { label: string; note: string; onClick: () => void }) {
  return (
    <button className="toc-row" onClick={onClick}>
      <span className="toc-name">{label}</span>
      <span className="toc-leader" aria-hidden="true" />
      <span className="toc-note">{note}</span>
    </button>
  );
}

export default function HomeView() {
  const db = useDrillStore();
  useStoreSync(chatStore);
  useStoreSync(journalStore);
  useStoreSync(examStore);
  useStoreSync(memoryStore);
  const { projectId, openDrill, openCards, openChat, openJournal, openExam } = useRoute();

  // The review store is loaded before the app paints; the four IndexedDB
  // stores are not, and Home is the one page that reads all of them at once.
  // init() is idempotent, so re-running it on mount just resolves.
  useEffect(() => {
    void chatStore.init();
    void journalStore.init();
    void examStore.init();
    void memoryStore.init();
  }, []);

  const project = db.projects[projectId];
  const decks = store.decksOf(projectId);
  const deckIds = new Set(decks.map((d) => d.id));

  /* db.log is global — one line per grade, whatever project it belonged to.
     Everything on this page is scoped to the project in the sidebar, so the
     log is filtered the same way before any of it is counted.

     stats() and counts() are handed the same decks for the same reason. Left
     to their defaults they read pool(), which is the *active deck* unless
     mixing is on, and their review counts came off the whole of db.log — so
     this page used to print "12 reviewed today" from every project you own
     directly above an activity grid that showed only this one, and an empty
     grid read as "nothing written down yet" while the figure above it said
     otherwise. One scope, one story. */
  const log = db.log.filter((e) => deckIds.has(e.d));
  const elsewhere = db.log.length - log.length;

  /* Every day this project has had, from every section — reviews, cards
     written, notes, journal, conversations, exams, memory. The service
     memoises against every store's version, so this is one walk per actual
     change rather than one per render; the useStoreSync calls above are what
     make the change arrive here at all. */
  const days = activity.daysFor(projectId);
  const todayActivity = todayOf(days);

  const s = store.stats(decks);
  const counts = store.counts(decks);
  const session = store.session();
  const { current: streak, longest, activeDays } = streaks(days);
  const week = weekOf(days);
  const retention = s.rev > 0 ? Math.round((s.ok / s.rev) * 100) : null;

  const cards = decks.reduce((n, d) => n + d.cards.length, 0);
  const seen = decks.reduce((n, d) => n + d.cards.filter((c) => d.srs[c.id]?.reps).length, 0);

  const journal = journalStore.listForProject(projectId);
  const exams = examStore.listForProject(projectId);
  const convos = chatStore
    .list()
    .filter((c) => c.projectId === projectId && !c.archived)
    .sort((a, b) => b.updated - a.updated);
  const memories = memoryStore.list({ scope: "project", projectId, activeOnly: true });

  /* Average score across finished exams. Unanswered questions are left out
     rather than counted wrong — an exam you walked away from halfway is not
     evidence that you failed the half you never saw. */
  const graded = exams.filter((e) => e.finishedAt);
  const examAvg = graded.length
    ? Math.round(
        (graded.reduce((acc, e) => {
          const answered = e.questions.filter((q) => q.result);
          const right = answered.filter((q) => q.result?.verdict === "got").length;
          return acc + (answered.length ? right / answered.length : 0);
        }, 0) /
          graded.length) *
          100
      )
    : null;

  if (!project) return null;

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  /* One thing to do next, and always the truest one: what is due, then what
     is new, then nothing — said plainly rather than dressed up as an
     achievement. */
  const fresh = Math.min(counts.newLeft, counts.unseen);

  /* The epigraph says where you stand in one line. It is the only sentence on
     the page allowed to be about you rather than about the data, which is
     what makes it worth reading — so it must stay honest: a broken streak is
     named, not softened. */
  const epigraph =
    activeDays === 0
      ? elsewhere > 0
        ? `Nothing in ${project.name} yet — your ${elsewhere.toLocaleString()} reviews so far belong to other projects.`
        : "Nothing written down yet. Every book starts on a blank page."
      : streak >= 2
        ? `Day ${streak} without a gap.` + (streak >= longest ? " Your longest run yet." : ` Your best is ${longest}.`)
        : streak === 1
          ? todayActivity.total > 0
            ? "One day in. The second is the one that counts."
            : "Yesterday counted. Anything at all today makes it two."
          : week.total > 0
            ? "The thread dropped. Pick it back up today and it barely shows."
            : `Nothing for a week. ${cards - seen > 0 ? "The cards are still there." : "Start again where you left off."}`;
  const call =
    counts.due > 0
      ? {
          head: `${counts.due} card${counts.due === 1 ? "" : "s"} due`,
          sub: "Pick up where you left off.",
          cta: "Start reviewing"
        }
      : fresh > 0
        ? {
            head: `${fresh} new card${fresh === 1 ? "" : "s"} ready`,
            sub: "Nothing is due — this would be new ground.",
            cta: "Learn something new"
          }
        : cards === 0
          ? {
              head: "No cards yet",
              sub: "Make a deck and the rest of this page fills itself in.",
              cta: "Open Review"
            }
          : {
              head: "You are clear for today",
              sub: `The next card comes back in ${store.nextDue() || "a while"}.`,
              cta: "Review anyway"
            };

  return (
    <Shell current="home" aside={<HomeRail days={days} projectId={projectId} />} asideLabel="This week">
      <div className="app-scroll">
        <div className="page home">
          <header className="home-hello">
            <div className="home-folio">
              {today} · {project.name}
            </div>
            <h2>
              <Icon name="sparkle" size={24} className="home-hello-mark" />
              {greeting()}
            </h2>
            {/* The epigraph. One italic line that says where you stand — the
                part of a chapter opening that makes you want to read on. */}
            <p className="home-epigraph">{epigraph}</p>
            <div className="home-rule" />
          </header>

          <button className="home-call" onClick={openDrill}>
            <span className="home-call-txt">
              <span className="home-call-head">{call.head}</span>
              <span className="home-call-sub">{call.sub}</span>
            </span>
            <span className="home-call-cta">
              {call.cta}
              <Icon name="send" size={15} />
            </span>
          </button>

          {/* The four numbers that describe a practice, in the order you
              actually ask them: am I keeping it up, did I do today, what is
              waiting, is any of it sticking. */}
          <div className="home-figs">
            <Figure
              value={streak}
              label="day streak"
              note={streak === 0 ? "none going" : `best ${longest}`}
              tone={streak > 0 ? "accent" : "muted"}
            />
            {/* Everything, not just cards graded — the breakdown is the strip
                under Activity, so the note here says the review half rather
                than repeating it. */}
            <Figure
              value={todayActivity.total}
              label="done today"
              note={
                todayActivity.total === 0
                  ? "nothing logged yet"
                  : session
                    ? `run ${session.done} of ${session.target}`
                    : `${s.today} reviewed`
              }
              tone={todayActivity.total > 0 ? "green" : "muted"}
            />
            <Figure
              value={counts.due}
              label="due now"
              note={counts.newLeft > 0 ? `${counts.newLeft} new allowed` : "new limit reached"}
              tone={counts.due === 0 ? "muted" : undefined}
            />
            <Figure
              value={retention === null ? "—" : retention + "%"}
              label="recall, 30 days"
              note={
                retention === null ? "not enough reviews" : `target ${Math.round(store.settings().retention * 100)}%`
              }
              tone={retention === null ? "muted" : undefined}
            />
          </div>

          <BackupNudge />

          {/* Every section feeds this, which is the whole point of it being on
              the front page rather than in Review: an evening of journal, chat
              and an exam used to draw a blank square and break the streak, and
              an app that tells you a productive day did not happen is worse
              than one with no calendar at all.

              An empty grid is still ambiguous — it looks the same whether you
              have never done anything or your history is filed under another
              project — so it says which. */}
          <Section
            title="Activity"
            note={
              activeDays > 0
                ? `${activeDays} active ${activeDays === 1 ? "day" : "days"}`
                : elsewhere > 0
                  ? "none in this project"
                  : undefined
            }
          >
            <TodayStrip day={todayActivity} />
            <ActivityGrid days={days} />
            <p className="home-note">
              Every section counts: cards reviewed and written, notes, journal entries, conversations, exams and
              memories saved. Hover a square to see what a day held.
            </p>
            {activeDays === 0 && elsewhere > 0 && (
              <p className="home-empty">
                {elsewhere.toLocaleString()} review{elsewhere === 1 ? "" : "s"} are logged against decks in your
                other projects. Switch project in the sidebar to see them.
              </p>
            )}
          </Section>

          <Section title="Contents">
            <div className="toc">
              <Entry
                label="Review"
                note={counts.due > 0 ? `${counts.due} waiting` : fresh > 0 ? `${fresh} new to meet` : "clear"}
                onClick={openDrill}
              />
              <Entry
                label="Cards"
                note={cards === 0 ? "none written yet" : `${cards} written · ${seen} seen`}
                onClick={openCards}
              />
              <Entry
                label="Journal"
                note={
                  journal.length
                    ? `${journal.length} ${journal.length === 1 ? "entry" : "entries"} · ${ago(journal[0].updated)}`
                    : "nothing written yet"
                }
                onClick={() => openJournal()}
              />
              <Entry
                label="Exam"
                note={
                  exams.length
                    ? `${exams.length} sat${examAvg !== null ? ` · ${examAvg}% average` : ""}`
                    : "none sat yet"
                }
                onClick={() => openExam(null)}
              />
              <Entry
                label="Chat"
                note={
                  convos.length
                    ? `${convos.length} ${convos.length === 1 ? "thread" : "threads"} · ${ago(convos[0].updated)}`
                    : "no conversations yet"
                }
                onClick={() => openChat(null)}
              />
            </div>
          </Section>

          <Section title="Decks" note={`${seen} of ${cards} cards seen`}>
            {decks.length === 0 ? (
              <p className="home-empty">No decks in this project yet — make some from Review.</p>
            ) : (
              <ul className="home-decks">
                {decks.map((d) => {
                  const total = d.cards.length;
                  const done = d.cards.filter((c) => d.srs[c.id]?.reps).length;
                  const pct = total ? Math.round((done / total) * 100) : 0;
                  return (
                    <li key={d.id}>
                      <button className="home-deck" onClick={openDrill} title={`Review ${d.name}`}>
                        <span className="home-deck-name">{d.name}</span>
                        <span className="home-deck-bar">
                          <i style={{ width: pct + "%" }} />
                        </span>
                        <span className="home-deck-n">
                          {done}/{total}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="What has built up">
            <div className="home-tally">
              <div>
                <b>{memories.length}</b> memories held for this project
              </div>
              <div>
                <b>{s.last7}</b> reviews in the last seven days
              </div>
              <div>
                <b>{s.leech}</b> {s.leech === 1 ? "card keeps" : "cards keep"} slipping
              </div>
              <div>
                <b>{journal.filter((e) => e.distilled.at).length}</b> journal entries distilled
              </div>
            </div>
          </Section>

          <div className="home-footer">
            <a href="https://github.com/frontier-contributor/drill" target="_blank" rel="noopener noreferrer" className="home-github-link" title="View on GitHub">
              <Icon name="github" size={18} />
              GitHub
            </a>
          </div>
        </div>
      </div>
    </Shell>
  );
}
