/* ============================================================================
 * Rescue — what Drill shows instead of a white page.
 *
 * Two failures end up here, and both used to end in a blank window with the
 * learner's data sitting intact and unreachable behind it:
 *
 *   RootGuard     a render crash anywhere in the tree. There was no error
 *                 boundary above Shell and Sidebar, so a crash in either — or
 *                 in any view, or a composer chip rendered before its new prop
 *                 was threaded through, which really happened — took down
 *                 every section at once. ErrorGuard contains the panels that
 *                 wrap themselves in it; this is the floor under everything
 *                 else.
 *
 *   BootRescue    the app could not start. The one that matters is a saved
 *                 database that no longer parses: store.init() used to
 *                 replace it with a fresh one and save over the original.
 *                 Now it throws, and this page offers the bytes before
 *                 anything is allowed to discard them.
 *
 * A third case rides on the first and is the commonest of all on a static
 * host: a tab left open across a deploy asks for a lazy chunk by its old
 * hashed name, the file is gone, and React.lazy throws. Nothing is broken
 * and nothing needs reporting — the page is simply older than the site — so
 * it gets its own sentence and a Reload, not a stack trace.
 *
 * Deliberately self-contained: no contexts, no stores subscribed, no
 * stylesheet but the eager one. Whatever broke may be any of those. The
 * backup module is imported only when the button is pressed, so it costs the
 * first paint nothing, and a raw download of the stored bytes stands behind it
 * in case the full export is what is failing.
 * ========================================================================== */
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import * as storage from "@/services/storage";
import { download } from "@/lib/util";

/** A dynamic import that failed because the file is not on the server any
 *  more. Each engine words it differently; all three are matched. */
export function isStaleChunk(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Unable to preload CSS/i.test(msg) ||
    (err instanceof Error && err.name === "ChunkLoadError")
  );
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** The stored review database exactly as it sits on disk, keys blanked. The
 *  last resort, and the only one that works when the thing that is broken is
 *  the database itself. */
function downloadRaw(): boolean {
  const raw = storage.readCurrent();
  if (!raw) return false;
  download(`drill-rescued-${stamp()}.json`, storage.redactKeys(raw), "application/json");
  return true;
}

/** The full backup — every store, the same file Settings → Data writes —
 *  falling back to the raw database if assembling it throws. */
function useBackupButton() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "raw" | "failed">("idle");
  function run() {
    setState("busy");
    import("@/services/backup")
      .then((b) => b.downloadEverything())
      .then(() => setState("done"))
      .catch((e) => {
        console.error("Rescue: full backup failed, falling back to the raw database", e);
        setState(downloadRaw() ? "raw" : "failed");
      });
  }
  const label =
    state === "busy"
      ? "Gathering everything…"
      : state === "done"
        ? "Backup downloaded"
        : state === "raw"
          ? "Saved the review database"
          : state === "failed"
            ? "Nothing could be read"
            : "Download a backup";
  const note =
    state === "raw"
      ? "The full backup could not be assembled, so this is the review database on its own — decks, scheduling, history and settings, without chats or the journal."
      : state === "failed"
        ? "This browser would not hand over what it has stored. Try Reload; if that fails too, do not clear site data."
        : null;
  return { run, label, note, busy: state === "busy" };
}

function details(err: unknown, stack?: string | null): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return [
    `${e.name}: ${e.message}`,
    `at ${window.location.hash || "#/"} · ${new Date().toISOString()}`,
    `${navigator.userAgent}`,
    "",
    e.stack || "",
    stack ? "\nComponent stack:" + stack : ""
  ].join("\n");
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => setDone(false)
        );
      }}
    >
      {done ? "Copied" : "Copy details"}
    </button>
  );
}

/* ------------------------------------------------------------- RootGuard -- */

interface GuardState {
  error: unknown;
  stack: string | null;
  /** The hash the crash happened on. Navigating anywhere else clears the
   *  failure, which is what makes the links on the page work. */
  at: string;
}

export class RootGuard extends Component<{ children: ReactNode }, GuardState> {
  state: GuardState = { error: null, stack: null, at: "" };

  static getDerivedStateFromError(error: unknown): Partial<GuardState> {
    return { error, at: window.location.hash };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Drill crashed while drawing", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  componentDidMount() {
    window.addEventListener("hashchange", this.onHash);
  }

  componentWillUnmount() {
    window.removeEventListener("hashchange", this.onHash);
  }

  private onHash = () => {
    if (this.state.error && window.location.hash !== this.state.at) this.reset();
  };

  private reset = () => this.setState({ error: null, stack: null, at: "" });

  render() {
    if (!this.state.error) return this.props.children;
    return <CrashPage error={this.state.error} stack={this.state.stack} onRetry={this.reset} />;
  }
}

/** The project id out of the hash, so "Go to review" stays in the project
 *  you were in rather than dropping you somewhere else. */
function projectHash(view: string): string {
  const m = /^#\/p\/([^/]+)/.exec(window.location.hash);
  return m ? `#/p/${m[1]}/${view}` : "#/";
}

function elsewhere(view: string): boolean {
  return !window.location.hash.startsWith(projectHash(view));
}

function CrashPage({ error, stack, onRetry }: { error: unknown; stack: string | null; onRetry: () => void }) {
  const backup = useBackupButton();
  const stale = isStaleChunk(error);
  const text = details(error, stack);

  return (
    <div className="app">
      <div className="app-scroll">
        <div className="rescue" role="alert">
          <div className="label">{stale ? "Drill has been updated" : "This page failed to draw"}</div>
          <h2>{stale ? "Reload to get the new version." : "Something broke — your work did not."}</h2>
          {stale ? (
            <p>
              This tab was opened before the latest version went up, and part of it that it asked for no longer exists
              under the old name. Reloading fetches the new one. Everything you had saved is kept.
            </p>
          ) : (
            <p>
              A part of this screen threw an error while drawing. What you had saved is stored separately from the page
              and is untouched. Try again, go somewhere else in the app, or reload. If it keeps happening here, take a
              backup first — it is one file and it takes a second.
            </p>
          )}

          <div className="rescue-acts">
            {stale ? (
              <button className="btn pri" onClick={() => window.location.reload()}>
                Reload
              </button>
            ) : (
              <>
                <button className="btn pri" onClick={onRetry}>
                  Try again
                </button>
                {/* A link to where you already are fires no hashchange and
                    would do nothing, so only the other one is offered. */}
                {elsewhere("drill") && (
                  <a className="btn" href={projectHash("drill")}>
                    Go to Review
                  </a>
                )}
                {elsewhere("home") && (
                  <a className="btn" href={projectHash("home")}>
                    Go to Home
                  </a>
                )}
                <button className="btn" onClick={() => window.location.reload()}>
                  Reload
                </button>
              </>
            )}
            <button className="btn" disabled={backup.busy} onClick={backup.run}>
              {backup.label}
            </button>
          </div>
          {backup.note && <p className="rescue-note">{backup.note}</p>}

          {!stale && (
            <details className="rescue-details">
              <summary>What went wrong</summary>
              <pre>{text}</pre>
              <div className="btnrow">
                <CopyButton text={text} />
                <a className="btn sm" href="https://github.com/AayushtheCoder01/drill/issues/new" target="_blank" rel="noreferrer">
                  Report it
                </a>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ BootRescue -- */

/**
 * The app did not start. `unreadable` is the case with a decision in it: the
 * database is on disk and cannot be parsed, so the choices are to take it
 * away as a file, or to discard it and begin again — and the second is two
 * presses, the first of which says exactly what goes.
 */
export function BootRescue({ error, unreadable }: { error: Error; unreadable: boolean }) {
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const bytes = storage.storedBytes();

  function save() {
    setSaved(downloadRaw());
  }

  function startOver() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    if (storage.discardCurrent()) window.location.reload();
  }

  return (
    <div className="app">
      <div className="app-scroll">
        <div className="rescue" role="alert">
          <div className="label">Drill could not start</div>
          {unreadable ? (
            <>
              <h2>Your saved data is here, but it could not be read.</h2>
              <p>
                The database this browser holds for Drill{bytes ? ` (${Math.round(bytes / 1024).toLocaleString()} KB)` : ""} is
                damaged or in a shape this version does not recognise. Nothing has been changed or written over. Download
                it first — a damaged file can often be repaired by hand, or by a later version of Drill — and only then
                decide whether to start over.
              </p>
            </>
          ) : (
            <>
              <h2>Something stopped the app from loading.</h2>
              <p>Reloading usually clears it. If it does not, the details below are what to send.</p>
            </>
          )}

          <div className="rescue-acts">
            {unreadable && (
              <button className="btn pri" onClick={save}>
                {saved ? "Downloaded — keep it safe" : "Download the saved data"}
              </button>
            )}
            <button className={"btn" + (unreadable ? "" : " pri")} onClick={() => window.location.reload()}>
              Reload
            </button>
            {unreadable && (
              <button className={"btn" + (confirming ? " danger" : "")} onClick={startOver}>
                {confirming ? "Yes — discard it and start fresh" : "Start over without it…"}
              </button>
            )}
          </div>
          {confirming && (
            <p className="rescue-note">
              {saved
                ? "The copy you downloaded is the only one left after this. Chats, the journal and memory are stored separately and are not touched."
                : "You have not downloaded it. Once discarded it cannot be recovered from this browser. Chats, the journal and memory are stored separately and are not touched."}
            </p>
          )}

          <details className="rescue-details">
            <summary>What went wrong</summary>
            <pre>{details(error)}</pre>
            <div className="btnrow">
              <CopyButton text={details(error)} />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
