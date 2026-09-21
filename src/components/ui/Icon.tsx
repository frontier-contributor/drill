/* ============================================================================
 * Icon — the app's whole icon set, in one file.
 *
 * Drill used to draw its buttons with whatever Unicode glyph was closest
 * (◧ ▤ ⌘ ✦ ⋯ ✕ ▼ ★ 🎙): different metrics, different weights, different
 * vertical centring, and a different shape on every platform. These are one
 * grid, one stroke weight, one join style, and they inherit currentColor —
 * so a row of them finally looks like a row of them.
 * ========================================================================== */
import type { SVGProps } from "react";

export type IconName =
  | "moon"
  | "sun"
  | "settings"
  | "sparkle"
  | "more"
  | "close"
  | "chevron"
  | "plus"
  | "search"
  | "panel"
  | "star"
  | "star-filled"
  | "mic"
  | "pencil"
  | "archive"
  | "copy"
  | "send"
  | "stop"
  | "home"
  | "review"
  | "cards"
  | "journal"
  | "exam"
  | "figure"
  | "image"
  | "paperclip"
  | "bubble"
  | "check"
  | "keyboard"
  | "help"
  | "refresh"
  | "globe"
  | "brain"
  | "sliders"
  | "speaker"
  | "play"
  | "pause"
  | "skip-back"
  | "skip-forward"
  | "pin"
  | "github";

/* Every path is drawn on a 24-grid, stroked, never filled — except the two
   that mean "on" (star-filled), where a fill is the whole signal. */
const PATHS: Record<IconName, { d: string; fill?: boolean }[]> = {
  moon: [{ d: "M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z" }],
  sun: [
    { d: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
    { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }
  ],
  settings: [
    { d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" },
    {
      d: "M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3.2a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9.4a1.6 1.6 0 0 0 1-1.5V3.2a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1Z"
    }
  ],
  sparkle: [
    { d: "M12 3.5 13.6 8 18 9.6 13.6 11.2 12 15.7 10.4 11.2 6 9.6 10.4 8Z" },
    { d: "M18.5 15.5 19.2 17.3 21 18l-1.8.7-.7 1.8-.7-1.8L16 18l1.8-.7Z" }
  ],
  more: [
    { d: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z", fill: true },
    { d: "M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z", fill: true },
    { d: "M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z", fill: true }
  ],
  close: [{ d: "M6 6l12 12M18 6L6 18" }],
  chevron: [{ d: "M5 9l7 7 7-7" }],
  plus: [{ d: "M12 5v14M5 12h14" }],
  search: [{ d: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4.1-4.1" }],
  panel: [{ d: "M4 5h16v14H4zM10 5v14" }],
  star: [{ d: "m12 3.7 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.8l5.8-.8Z" }],
  "star-filled": [{ d: "m12 3.7 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.8l5.8-.8Z", fill: true }],
  mic: [{ d: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM19 11a7 7 0 0 1-14 0M12 18v3" }],
  pencil: [{ d: "M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16Z" }],
  archive: [{ d: "M3 7h18v3H3zM5 10v9h14v-9M10 14h4" }],
  copy: [{ d: "M9 9h11v11H9zM5 15H4V4h11v1" }],
  send: [{ d: "M4.5 12h15M13 5.5 19.5 12 13 18.5" }],
  stop: [{ d: "M7 7h10v10H7z" }],
  /* The four sections. Drawn as the object each one is — a stack of cards,
     an open book, a marked paper, a spoken line — rather than as abstract
     marks, because in the collapsed rail the icon is the only label left. */
  home: [{ d: "M3.5 10.5 12 3.5l8.5 7" }, { d: "M5.5 9.2V20h13V9.2" }, { d: "M9.8 20v-5.6h4.4V20" }],
  review: [{ d: "M3.5 9.5h12v10.5h-12z" }, { d: "M7 6h12v10.5" }],
  cards: [{ d: "M7.5 7.5h13v11h-13z" }, { d: "M4.5 5.5h13v1.2" }, { d: "M10.5 11.5h7M10.5 14.5h4" }],
  journal: [
    { d: "M12 6.6c-1.6-1.4-4-2.1-7-2.1v13c3 0 5.4.7 7 2.1 1.6-1.4 4-2.1 7-2.1v-13c-3 0-5.4.7-7 2.1Z" },
    { d: "M12 6.6v13" }
  ],
  bubble: [{ d: "M20.5 11.8a7.7 7.7 0 0 1-11.2 6.9L4 20l1.4-4.2a7.7 7.7 0 1 1 15.1-4Z" }],
  exam: [
    { d: "M9.5 3.5h5v3h-5z" },
    { d: "M14.5 5h2.5a1 1 0 0 1 1 1v13.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" },
    { d: "m9.5 13 1.8 1.8 3.4-3.6" }
  ],
  /* A figure, framed and hung: the Figures section, where a diagram, a chart
     or a canvas goes when it is worth coming back to. */
  figure: [{ d: "M4 5.5h16v13H4z" }, { d: "M7 15.2l3.4-3.9 2.5 2.5L17 9.2" }],
  /* A photograph, as distinct from a figure: the same frame with a horizon and
     a sun in it rather than a plotted line. One is drawn, the other is taken. */
  image: [
    { d: "M4 5.5h16v13H4z" },
    { d: "M9.1 10.4a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0" },
    { d: "M4.4 16.6l4.3-4.3 3 3 3.3-3.6 4.6 4.9" }
  ],
  paperclip: [
    { d: "m21.4 11.6-8.5 8.5a5.6 5.6 0 0 1-7.9-7.9l8.5-8.5a3.8 3.8 0 0 1 5.3 5.3l-8.5 8.5a1.9 1.9 0 0 1-2.7-2.7l7.8-7.8" }
  ],
  check: [{ d: "M5 13l4 4L19 7" }],
  keyboard: [
    { d: "M3 6h18v12H3z" },
    { d: "M7 10h.01M11 10h.01M15 10h.01M7 14h.01M17 14h.01M10 14h4" }
  ],
  help: [{ d: "M12 17h.01M9 9a3 3 0 1 1 5 2c-.9.7-2 1.4-2 3v1" }],
  refresh: [
    { d: "M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.4 6.4L3 16M3 21v-5h5" }
  ],
  globe: [
    { d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
    { d: "M3.5 9h17M3.5 15h17" },
    { d: "M12 3c2.3 2.4 3.5 5.4 3.5 9s-1.2 6.6-3.5 9c-2.3-2.4-3.5-5.4-3.5-9s1.2-6.6 3.5-9Z" }
  ],
  /* A head with a coil inside it rather than the usual lobed brain: at 13px a
     brain is a grey smudge, and the point of the glyph is "thinking", not
     anatomy. */
  brain: [
    { d: "M15.5 20.5v-2.4c2.6-1 4.3-3.4 4.3-6.3A7.8 7.8 0 0 0 4.4 10L2.8 13.4h2.4v3.2c0 1.1.9 2 2 2h1.6v1.9" },
    { d: "M9.4 12.6c0-1.4 1.2-2.6 2.6-2.6s2.6 1.2 2.6 2.6-1.2 2-2.6 2.6" }
  ],
  sliders: [
    { d: "M4 7h9M17 7h3M4 17h3M11 17h9" },
    { d: "M15 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM7 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z" }
  ],
  /* Listening. The speaker's waves are drawn open so the glyph still reads at
     11px in a reply's action row, where a filled cone would be a blot. */
  speaker: [{ d: "M4 9.5h3.2L12 5.5v13l-4.8-4H4z" }, { d: "M15.5 9.2a4 4 0 0 1 0 5.6" }, { d: "M18.2 6.6a7.6 7.6 0 0 1 0 10.8" }],
  play: [{ d: "M8 5.8v12.4a.6.6 0 0 0 .9.5l9.6-6.2a.6.6 0 0 0 0-1L8.9 5.3a.6.6 0 0 0-.9.5Z" }],
  pause: [{ d: "M8.5 5.5v13M15.5 5.5v13" }],
  "skip-back": [{ d: "M6 5.5v13" }, { d: "M18 6.2v11.6a.6.6 0 0 1-.9.5l-7.7-5.8a.6.6 0 0 1 0-1l7.7-5.8a.6.6 0 0 1 .9.5Z" }],
  "skip-forward": [{ d: "M18 5.5v13" }, { d: "M6 6.2v11.6a.6.6 0 0 0 .9.5l7.7-5.8a.6.6 0 0 0 0-1L6.9 5.7a.6.6 0 0 0-.9.5Z" }],
  /* A pushpin: what an attachment pinned to a conversation is, and the one
     thing a paperclip beside it could not also mean. */
  pin: [{ d: "M9.5 3.5h5l-.8 6 3.3 3.2v1.3H7v-1.3l3.3-3.2Z" }, { d: "M12 14v6.5" }],
  /* The one glyph in this set that is a fixed logo rather than a drawn
     concept — the Octocat silhouette, filled rather than stroked like
     star-filled, because approximating it in strokes on a 24-grid reads as
     a smear rather than a recognisable mark. */
  github: [
    {
      d: "M12 .8C5.86.8.9 5.78.9 11.94c0 4.93 3.2 9.1 7.63 10.58.56.1.76-.24.76-.54 0-.26-.01-1.13-.02-2.05-3.1.67-3.76-1.32-3.76-1.32-.51-1.3-1.24-1.64-1.24-1.64-1.02-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15 1 1.7 2.63 1.21 3.27.93.1-.72.39-1.21.71-1.49-2.48-.28-5.08-1.24-5.08-5.51 0-1.22.44-2.21 1.15-2.99-.11-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.14a10.7 10.7 0 0 1 5.6 0c2.14-1.44 3.08-1.14 3.08-1.14.61 1.54.22 2.68.11 2.96.72.78 1.15 1.77 1.15 2.99 0 4.28-2.61 5.22-5.1 5.5.4.35.76 1.03.76 2.08 0 1.5-.01 2.71-.01 3.08 0 .3.2.65.77.54 4.42-1.48 7.61-5.65 7.61-10.58C23.1 5.78 18.14.8 12 .8Z",
      fill: true
    }
  ]
};

export default function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name].map((p, i) => (
        <path key={i} d={p.d} fill={p.fill ? "currentColor" : "none"} stroke={p.fill ? "none" : "currentColor"} />
      ))}
    </svg>
  );
}
