/* ============================================================================
 * ProjectScope — what this space is, what it hands down to conversations
 * started inside it, what it is allowed to remember, and what it owns.
 *
 * Replaces the window.prompt sequence ProjectSwitcher used to edit a project
 * with — same data, a real form.
 *
 * The personal space arrives here too, and reads differently on purpose. It
 * has no goals, because it is not aimed at anything; the same field is the
 * standing instruction for chats that belong to nothing, which is a different
 * sentence for the same box. Its name and blurb are fixed, and it owns no
 * decks worth listing, so those parts are simply not offered rather than
 * offered and ignored.
 * ========================================================================== */
import { useRef, useState } from "react";
import * as store from "@/services/store";
import * as projects from "@/services/projects";
import * as AI from "@/services/ai";
import { PERSONAS } from "@/lib/personas";
import { useDrillStore } from "@/hooks/useDrillStore";
import { useToast } from "@/context/ToastContext";
import SelectRow from "../ui/SelectRow";
import ModelPicker from "../ui/ModelPicker";
import NumberRow from "../ui/NumberRow";
import TextRow from "../ui/TextRow";
import Section from "./Section";
import DeckList from "./DeckList";
import type { Autonomy, BackendType, Effort } from "@/types";
import Icon from "../ui/Icon";

/** Reads the active project itself rather than being handed one. The caller
 *  is a table of categories with no store subscription of its own, so a
 *  projectId passed down from there would be whatever it was when the panel
 *  opened — switching space behind the panel would leave this editing the
 *  previous one. */
export default function ProjectScope({ projectId: given }: { projectId?: string }) {
  useDrillStore();
  const projectId = given || store.get().activeProjectId;
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [knowledgeText, setKnowledgeText] = useState("");
  const [knowledgeName, setKnowledgeName] = useState("");

  const p = store.projects()[projectId];
  if (!p) return <div className="empty">Project not found.</div>;

  const personal = projects.isPersonalProject(projectId);

  function addKnowledgeText() {
    if (!knowledgeText.trim()) return;
    projects.addKnowledge(projectId, knowledgeName.trim() || "Note", "text", knowledgeText.trim());
    setKnowledgeText("");
    setKnowledgeName("");
    toast("Added to project knowledge");
  }

  /* The same reader chat uses, for text only: a PDF, a Word document or a
     spreadsheet becomes knowledge as the text in it. Knowledge rides on every
     message, so a picture — which would too — is refused with a sentence. */
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    toast(`Reading ${f.name}…`, 30_000);
    try {
      const { ingest } = await import("@/services/files/ingest");
      const a = await ingest(f, { purpose: "text" });
      projects.addKnowledge(projectId, a.name, "file", a.text);
      toast(`Added ${a.name}${a.truncated ? " (clipped at the limit)" : ""}`);
    } catch (err) {
      toast((err as Error).message || `Could not read ${f.name}`, 8000);
    }
  }

  const decks = store.decksOf(projectId);

  return (
    <>
      <Section
        id="project.identity"
        title={personal ? "Personal" : "This project"}
        sub={
          personal
            ? "The space for chats that belong to nothing. It is always here and cannot be archived."
            : "The name in the switcher, and the one line of purpose that rides on every chat turn started here."
        }
      >
        {!personal && (
          <>
            <TextRow title="Name" value={p.name} onCommit={(v) => v.trim() && projects.rename(projectId, v)} />
            <TextRow
              title="Blurb"
              sub="Shown under the name in the switcher."
              value={p.blurb}
              onCommit={(v) => projects.update(projectId, { blurb: v.trim() })}
            />
          </>
        )}
        <TextRow
          title={personal ? "Standing instruction" : "Goals"}
          sub={
            personal
              ? "Prepended to every personal chat. What you want the assistant to know about you, in one paragraph."
              : "Injected as the project header on every chat turn, so keep it short."
          }
          value={p.goals}
          multiline
          placeholder={
            personal
              ? "e.g. I write TypeScript. Answer in code first, prose second."
              : 'e.g. "Understand ML well enough to implement from scratch."'
          }
          onCommit={(v) => projects.update(projectId, { goals: v.trim() })}
        />
      </Section>

      <Section id="project.defaults">
        <SelectRow
          title="Backend"
          value={p.defaults.backend}
          placeholder="Inherit from global"
          onChange={(v) => projects.updateDefaults(projectId, { backend: v as BackendType | "" })}
          options={AI.BACKEND_ORDER.map((id) => ({ value: id, label: AI.BACKENDS[id].label }))}
        />
        <ModelPicker
          title="Model"
          value={p.defaults.model}
          placeholder="Inherit from global"
          backend={p.defaults.backend || undefined}
          onChange={(v) => projects.updateDefaults(projectId, { model: v })}
        />
        <SelectRow
          title="Persona"
          value={p.defaults.personaId}
          placeholder="Inherit (Tutor)"
          onChange={(v) => projects.updateDefaults(projectId, { personaId: v })}
          options={PERSONAS.map((pr) => ({ value: pr.id, label: pr.name }))}
        />
        <SelectRow
          title="Effort"
          value={p.defaults.effort}
          placeholder="Inherit from global"
          onChange={(v) => projects.updateDefaults(projectId, { effort: v as Effort | "" })}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" }
          ]}
        />
      </Section>

      <Section id="project.memory">
        <SelectRow
          title="Autonomy"
          sub="How freely memory may be written without being asked."
          value={p.memoryPolicy.autonomy}
          onChange={(v) => projects.updateMemoryPolicy(projectId, { autonomy: v as Autonomy })}
          options={[
            { value: "manual", label: "Manual — nothing without review" },
            { value: "assisted", label: "Assisted — stated facts commit, the rest waits" },
            { value: "auto", label: "Auto" }
          ]}
        />
        <NumberRow
          title="Max global memories injected per turn"
          value={p.memoryPolicy.maxGlobalInjected}
          min={0}
          max={20}
          onChange={(v) => projects.updateMemoryPolicy(projectId, { maxGlobalInjected: v })}
        />
        <NumberRow
          title="Max project memories injected per turn"
          value={p.memoryPolicy.maxProjectInjected}
          min={0}
          max={30}
          onChange={(v) => projects.updateMemoryPolicy(projectId, { maxProjectInjected: v })}
        />
      </Section>

      <Section id="project.knowledge" title={`Knowledge (${p.knowledge.length})`}>
        <div className="list setlist">
          {p.knowledge.map((k) => (
            <div key={k.id} className="item static">
              <span className="grow">
                <span className="t">{k.name}</span>
                <span className="s">
                  {k.kind} · {k.size.toLocaleString()} chars{!k.enabled ? " · off" : ""}
                </span>
              </span>
              <button className="linkbtn" onClick={() => projects.setKnowledgeEnabled(projectId, k.id, !k.enabled)}>
                {k.enabled ? "disable" : "enable"}
              </button>
              <span className="x" onClick={() => projects.removeKnowledge(projectId, k.id)}>
                <Icon name="close" size={12} />
              </span>
            </div>
          ))}
          {!p.knowledge.length && <div className="empty">Nothing attached yet.</div>}
        </div>
        <input className="fi" placeholder="name (optional)" value={knowledgeName} onChange={(e) => setKnowledgeName(e.target.value)} />
        <textarea
          className="fi"
          placeholder="paste text to keep attached to every conversation here"
          value={knowledgeText}
          onChange={(e) => setKnowledgeText(e.target.value)}
        />
        <div className="btnrow">
          <button className="btn sm" onClick={addKnowledgeText}>
            Add text
          </button>
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            Add a file…
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.csv,.tsv,.md,.txt,.json,.tex,text/*"
          className="hidden-file"
          onChange={(e) => void onFile(e)}
        />
      </Section>

      {/* The personal space is not meant to own decks and starts with none —
          but ensureActiveDeck() will make it one the moment somebody reviews
          in it, and a deck you cannot rename or delete is worse than a section
          you did not expect. So it is offered when there is something to
          manage and hidden when there is not. */}
      {(!personal || decks.length > 0) && (
        <Section id="project.decks" title={`Decks (${decks.length})`}>
          <DeckList projectId={projectId} />
        </Section>
      )}
    </>
  );
}
