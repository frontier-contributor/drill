/* ============================================================================
 * ChatPrefs — the defaults every new conversation starts from.
 *
 * Effort is here because it had nowhere else to be. It is the bottom of an
 * inheritance chain — a project or a conversation that has not overridden it
 * falls through to `settings.effort` — and it was read by the send path while
 * being settable nowhere in the app. The project and conversation pickers
 * offered "inherit from global" for a global value the user could not reach,
 * which is the dead dial upside down: not a control that changes nothing, but
 * a value that changes things with no control.
 *
 * Memory autonomy used to be the second half of this page for the same reason.
 * It has its own page now, next to the tray and the memories themselves, which
 * is where somebody looking for it would actually go.
 *
 * Where a PDF is read is read by lib/files/carry.ts on every send, and nowhere
 * else — the one file setting, because it is the one with money in it.
 * ========================================================================== */
import * as store from "@/services/store";
import { EFFORT_ORDER, effortMeans } from "@/lib/effort";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useSettings } from "@/context/SettingsContext";
import SwitchRow from "../../ui/SwitchRow";
import SelectRow from "../../ui/SelectRow";
import Section from "../Section";
import { VISUALS, kindsOn, type VisualKind } from "@/lib/visuals/catalogue";
import { visualProtocol } from "@/lib/visuals/protocol";
import { estimateTokens } from "@/lib/tokens";
import type { Effort, PdfEngine } from "@/types";

/* Each says what it costs. Two of the four spend money, and one of those is
   what OpenRouter uses when a PDF arrives with no parser named — which is why
   the send path always names one. */
const PDF_ENGINES: { value: PdfEngine; label: string; sub: string }[] = [
  {
    value: "local",
    label: "In this browser",
    sub: "Free, private, and the same on every backend. Pages that are scans go to a model that can see as pictures."
  },
  {
    value: "cloudflare-ai",
    label: "OpenRouter · Cloudflare (free)",
    sub: "OpenRouter turns the PDF into text on its side, at no charge."
  },
  {
    value: "mistral-ocr",
    label: "OpenRouter · Mistral OCR (paid)",
    sub: "The best reading of scans and photographed pages. OpenRouter charges about $2 per thousand pages."
  },
  {
    value: "native",
    label: "OpenRouter · the model reads it",
    sub: "Sent to a model that reads PDFs itself, billed as input tokens. A model that cannot is sent the text from this browser instead."
  }
];

export default function ChatPrefs() {
  useDrillStore();
  const s = store.settings();
  const { open } = useSettings();
  const effort: Effort = s.effort || "medium";
  const engine = PDF_ENGINES.find((e) => e.value === s.pdfEngine) || PDF_ENGINES[0];
  const off = s.visualsOff || [];
  const teaching = estimateTokens(visualProtocol(kindsOn(off)));
  const toggleKind = (kind: VisualKind) =>
    store.updateSettings({ visualsOff: off.includes(kind) ? off.filter((k) => k !== kind) : [...off, kind] });

  return (
    <>
      <Section id="chat.effort">
        <div className="seg">
          {EFFORT_ORDER.map((e) => (
            <button key={e} className={effort === e ? "on" : ""} onClick={() => store.updateSettings({ effort: e })}>
              {e[0].toUpperCase() + e.slice(1)}
            </button>
          ))}
        </div>
        <p className="sset-note">{effortMeans(effort, "direct")}</p>
      </Section>

      <Section id="chat.requests">
        <SwitchRow
          title="Suggest follow-up questions"
          sub="Costs a second request after every reply. Off at low effort regardless."
          on={s.followups}
          onToggle={() => store.updateSettings({ followups: !s.followups })}
        />
        <SwitchRow
          title="Name conversations automatically"
          sub="One extra request per new thread, never per message. Off names it from your first line instead."
          on={s.autoTitle}
          onToggle={() => store.updateSettings({ autoTitle: !s.autoTitle })}
        />
        <p className="sset-note">
          What a conversation is allowed to remember is on the{" "}
          <button className="textlink" onClick={() => open("memory")}>
            Memory page
          </button>
          .
        </p>
      </Section>

      <Section id="chat.files">
        <SelectRow
          title="Read PDFs"
          sub={engine.sub}
          value={engine.value}
          options={PDF_ENGINES.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => store.updateSettings({ pdfEngine: v as PdfEngine })}
        />
        <p className="sset-note">
          The OpenRouter choices apply when chat is pointed at OpenRouter, in a Direct conversation. Everywhere else — Groq,
          Ollama, a custom server, Agent and Deep — PDFs are read in this browser. Pictures always go to a model that can see
          as themselves; Word, Excel and text files are always read here first.
        </p>
      </Section>

      <Section id="chat.figures">
        {VISUALS.map((v) => (
          <SwitchRow key={v.kind} title={v.label} sub={v.blurb} on={!off.includes(v.kind)} onToggle={() => toggleKind(v.kind)} />
        ))}
        <p className="sset-note">
          {teaching
            ? `Teaching these adds about ${teaching} tokens to the instructions on every message.`
            : "Nothing is taught, so nothing is drawn — a figure block shows as code."}{" "}
          A figure can be saved — SVG or PNG for the drawn ones, an HTML file for a canvas — and turned into cards like any
          other part of a reply. A canvas runs with no network at all, so nothing it was written with can leave this browser.
        </p>
      </Section>
    </>
  );
}
