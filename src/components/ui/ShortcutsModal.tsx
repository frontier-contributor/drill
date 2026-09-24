/* ============================================================================
 * ShortcutsModal — the cheatsheet for every key binding in Drill.
 *
 * Opened with "?" or from the sidebar, and owned by Shell so there is exactly
 * one of it however it was opened.
 *
 * Every row here is a promise, so every row is checked against the handler
 * that implements it: Shell (the frame), AppShell (the review loop),
 * ChatView and Composer (chat), Stage/TakeExam/CaptureBox (the writing
 * boxes). A cheatsheet that lists a key nothing listens for is worse than no
 * cheatsheet — you press it, nothing happens, and now you distrust the rest
 * of the list too.
 * ========================================================================== */
import Icon from "./Icon";

interface ShortcutGroup {
  title: string;
  note?: string;
  items: { keys: string[]; desc: string }[];
}

/* "Ctrl" throughout, and the handlers all accept metaKey too, so the same row
   reads correctly on a Mac without the modal having to know which it is. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    items: [
      { keys: [MOD, "B"], desc: "Show or hide the navigation" },
      { keys: [MOD, "\\"], desc: "Show or hide the right-hand panel" },
      { keys: [MOD, ","], desc: "Settings — the same panel from every section" },
      { keys: ["?"], desc: "This list" },
      { keys: ["Esc"], desc: "Close what is open, or leave the box you are typing in" }
    ]
  },
  {
    title: "Review",
    note: "While the card has the page — not while you are typing in the recall box.",
    items: [
      { keys: ["Space"], desc: "Turn the card over" },
      { keys: ["1"], desc: "Again" },
      { keys: ["2"], desc: "Hard" },
      { keys: ["3"], desc: "Good" },
      { keys: ["4"], desc: "Easy" },
      { keys: ["G"], desc: "Go deeper — open this card in chat" },
      { keys: ["N"], desc: "Log an insight" },
      { keys: ["S"], desc: "Statistics" }
    ]
  },
  {
    title: "Chat",
    items: [
      { keys: [MOD, "K"], desc: "Command palette" },
      { keys: [MOD, "J"], desc: "New conversation" },
      { keys: ["Enter"], desc: "Send" },
      { keys: ["Shift", "Enter"], desc: "New line instead of sending" },
      { keys: ["/"], desc: "Commands — at the start of an empty message" },
      { keys: ["@"], desc: "Point at a deck, note, card or journal entry" },
      { keys: ["Esc"], desc: "Clear the message you are writing" }
    ]
  },
  {
    title: "Voice",
    note: "In chat. The round button in the empty composer starts a call too.",
    items: [
      { keys: [MOD, "Shift", "V"], desc: "Start or end a voice conversation" },
      { keys: ["Space"], desc: "Hold to keep the floor through pauses — and to cut in while it talks" },
      { keys: ["M"], desc: "Mute or unmute the microphone" },
      { keys: ["Esc"], desc: "Leave full screen, then end the call" }
    ]
  },
  {
    title: "Listening",
    note: "While a reply is read with a hosted voice. Keyboard and headphone media keys reach it through the browser; this device's own voice cannot be reached that way.",
    items: [
      { keys: ["Play/Pause"], desc: "Pause or resume the reading" },
      { keys: ["Next track"], desc: "Skip to the next sentence" },
      { keys: ["Previous track"], desc: "Back a sentence" }
    ]
  },
  {
    title: "Writing boxes",
    note: "The recall box, an edited message, an exam answer, the journal capture.",
    items: [{ keys: [MOD, "Enter"], desc: "Commit it — check, save, or submit" }]
  }
];

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className="sheet-inner keys-sheet">
        <div className="sheet-head">
          <Icon name="keyboard" size={17} className="keys-head-icon" />
          <h3>Keyboard shortcuts</h3>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body keys-body">
          {SHORTCUTS.map((g) => (
            <section key={g.title} className="keys-group">
              <div className="label">{g.title}</div>
              {g.note && <p className="keys-note">{g.note}</p>}
              <dl className="keys-list">
                {g.items.map((item) => (
                  <div key={item.keys.join("+") + item.desc} className="keys-row">
                    <dt>{item.desc}</dt>
                    <dd>
                      {item.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
