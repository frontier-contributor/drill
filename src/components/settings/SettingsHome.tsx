/* ============================================================================
 * SettingsHome — a grouped rail, one page at a time, and a way to find a
 * control without knowing which page it is on.
 *
 * What was here before the settings rework was three tabs where the first held
 * fifteen unrelated controls in one column: the theme picker, then the accent
 * swatches, then the API key, then five switches, then the scheduler, then a
 * tutor prompt. Nothing grouped, nothing headed, no order anyone could name,
 * and a Save button at the bottom that applied to seven of the fields and not
 * to the other eight.
 *
 * Three things stay deliberate:
 *
 *   Conversation is the first page, not a bolted-on tab. Opened from a thread,
 *   the settings for *that thread* are the most local scope and belong at the
 *   front of the same rail — the three scopes are one inheritance chain
 *   (conversation beats project beats global), and showing them as one list is
 *   what makes that legible.
 *
 *   The rail is grouped and it does not scroll away. Nine flat names is a list
 *   you read; four headings with two or three names under each is a list you
 *   scan. Under 860px there is no room for a column beside the page, so the
 *   same list becomes the row of pills it used to be — one component, two
 *   shapes, no second navigation.
 *
 *   Search returns *settings*, not pages. Every page is one word you have to
 *   guess right, and the app has already lost a feature to that: backup and
 *   restore sat in the review loop's Menu while the person who needed it went
 *   looking under Settings. Typing "backup" now lands on the group that holds
 *   it, wherever it has ended up living, with it marked.
 * ========================================================================== */
import { useEffect, useMemo, useRef, useState } from "react";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useMaybeChat } from "@/context/chatCtx";
import { useSettings } from "@/context/SettingsContext";
import ErrorGuard from "../ui/ErrorGuard";
import Icon from "../ui/Icon";
import { GROUPS, SECTIONS, categoryMeta, search, type CatId, type SectionId } from "./catalogue";
import { categoriesFor, categoryById, labelOf } from "./registry";

const MOBILE = "(max-width: 900px)";

export default function SettingsHome() {
  /* Page names and bodies both read the store — the project page is called
     "Personal" in one space and by the project's own name in the others — so
     the rail has to re-render when it changes. */
  useDrillStore();

  /* "This chat" is offered where there is a chat to configure. Asking the
     context rather than taking a prop means no caller can offer the page in a
     view whose provider is not mounted, which is the version of this that
     throws. */
  const inChat = useMaybeChat() !== null;
  const cats = useMemo(() => categoriesFor({ conversation: inChat }), [inChat]);

  /* The page on screen lives in SettingsContext, not here, so that there is
     one answer to "which page". Falling back to the first available page
     covers the one case they can disagree: a page whose scope this view does
     not provide. */
  const { cat, open } = useSettings();
  const current = categoryById(cats.some((c) => c.id === cat) ? cat : cats[0].id);

  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const ids = useMemo(() => cats.map((c) => c.id), [cats]);
  const found = useMemo(() => search(query, ids), [query, ids]);

  /* Type-to-find, the way every settings panel worth using opens — but not on
     a phone, where focusing a text field throws the keyboard over half the
     screen before you have said what you want. */
  useEffect(() => {
    if (!window.matchMedia(MOBILE).matches) searchRef.current?.focus();
  }, []);

  function go(id: CatId, at?: SectionId) {
    open(id, at);
    setQuery("");
    searchRef.current?.blur();
  }

  return (
    <div className="setpage">
      <div className="setsearch">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          className="setsearch-in"
          type="search"
          value={query}
          placeholder="Search every setting — try “backup”, “retention”, “key”"
          aria-label="Search settings"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              /* Clears the search rather than closing the whole panel, and
                 stops there so the modal's own Escape does not also fire. */
              e.stopPropagation();
              setQuery("");
            }
            if (e.key === "Enter" && found.length) {
              const first = found[0];
              go(SECTIONS[first].cat, first);
            }
          }}
        />
        {/* Announced as well as shown: with results replacing the rail, the
            count is the only feedback that a query narrowed anything. */}
        {query && (
          <span className="setsearch-count" role="status" aria-live="polite">
            {found.length} {found.length === 1 ? "match" : "matches"}
          </span>
        )}
      </div>

      {query ? (
        /* Results take the whole panel rather than filtering the rail in
           place: a rail entry is one word, and one word does not tell you
           whether what you are hunting for is on that page. */
        <div className="setfound" aria-label="Matching settings">
          {found.map((id) => {
            const s = SECTIONS[id];
            return (
              <button key={id} className="setfound-row" onClick={() => go(s.cat, id)}>
                <span className="setfound-where">{labelOf(categoryMeta(s.cat))}</span>
                <span className="t">{s.title}</span>
                <span className="s">{s.sub}</span>
              </button>
            );
          })}
          {!found.length && (
            <div className="empty">
              Nothing matches “{query}”. Search covers every group of settings on every page — if what you are
              after really is missing, it is a bug, not a place you have not looked yet.
            </div>
          )}
        </div>
      ) : (
        <div className="setshell">
          <nav className="setnav" aria-label="Settings pages">
            {GROUPS.map((g) => {
              const inGroup = cats.filter((c) => c.group === g.id);
              if (!inGroup.length) return null;
              return (
                <div key={g.id} className="setnav-group">
                  <div className="label">{g.label}</div>
                  {inGroup.map((c) => (
                    <button
                      key={c.id}
                      className={"setnav-btn" + (c.id === current?.id ? " on" : "")}
                      aria-current={c.id === current?.id ? "page" : undefined}
                      onClick={() => go(c.id)}
                    >
                      {labelOf(c)}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>

          {/* Keyed on the page so switching clears a failure rather than
              leaving the whole panel stuck on the one page that threw. */}
          <div className="setbody">
            <ErrorGuard
              key={current?.id}
              fallback={
                <div className="empty">
                  This page could not be drawn. Nothing was changed — pick another one, and the console has the
                  details.
                </div>
              }
            >
              {current?.render()}
            </ErrorGuard>
          </div>

          <div className="setfooter">
            <a href="https://github.com/AayushtheCoder01/drill" target="_blank" rel="noopener noreferrer" className="setgithub-link" title="View on GitHub">
              <Icon name="github" size={16} />
              GitHub
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
