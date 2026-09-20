/* ============================================================================
 * ConversationScope — per-conversation model, persona, sampling and what the
 * model can see. Per-conversation on purpose: the model you want writing
 * cards is rarely the model you want for a long Socratic session.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as AI from "@/services/ai";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import { PERSONAS, getPersona } from "@/lib/personas";
import { priceForModel } from "@/services/pricing";
import { formatCost, formatTokens } from "@/lib/tokens";
import { describeSource, retrieveForSource } from "@/lib/chatContext";
import { originLabel, resolveBackend, resolveEffort, resolveModel } from "@/lib/resolveSetting";
import type { RetrievalTrace, ScoreComponents } from "@/lib/memoryRetrieval";
import { useMaybeChat } from "@/context/ChatContext";
import Section from "./Section";
import SelectRow from "../ui/SelectRow";
import ModelPicker from "../ui/ModelPicker";
import type { BackendType, Effort } from "@/types";
import type { ContextSource } from "@/types/chat";
import Icon from "../ui/Icon";

/** A one-line, human reason a memory scored where it did — the retrieval
 *  system is keyword+recency+usage+pin, not a black box, so the panel says
 *  which of those actually fired instead of just showing a number. */
function reasonFor(comp: ScoreComponents): string {
  const parts: string[] = [];
  if (comp.pinned > 0) parts.push("pinned");
  if (comp.keyword > 0.3) parts.push("keyword match");
  if (comp.usage > 0.3) parts.push("used often");
  if (comp.recency > 0.7) parts.push("recently updated");
  return parts.length ? parts.join(", ") : "filling the quota, low relevance";
}

export default function ConversationScope() {
  /* Settings is one panel opened from every section, and this page is the
     one that needs a context only chat mounts. The registry keeps it out of
     the list elsewhere; asking rather than demanding means a mistake there
     costs an empty page instead of a white screen. */
  const chat = useMaybeChat();
  const c = chat?.conversation ?? null;
  const [customPrompt, setCustomPrompt] = useState(c?.systemPrompt || "");

  useEffect(() => setCustomPrompt(c?.systemPrompt || ""), [c?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!chat) return <div className="empty">Open a conversation to change what it does.</div>;
  if (!c) return <div className="empty">Open or start a conversation first.</div>;
  const { update, setContext } = chat;

  const project = store.get().projects[c.projectId];
  const rBackend = resolveBackend(c, project);
  const rModel = resolveModel(c, project);
  const rEffort = resolveEffort(c, project);
  const resolved = AI.resolve({ backend: rBackend.value, model: rModel.value });
  const price = priceForModel(resolved.type, resolved.model);

  function hasSource(pred: (s: ContextSource) => boolean): boolean {
    return c!.context.some(pred);
  }
  function toggleSource(src: ContextSource, pred: (s: ContextSource) => boolean) {
    setContext(hasSource(pred) ? c!.context.filter((s) => !pred(s)) : [...c!.context, src]);
  }

  /* Preview exactly what the send path would pick, through the same function
     it uses. This block used to reimplement the pool filter inline, which meant
     the "why these were picked" panel could quietly disagree with what actually
     got sent. */
  const memSource = c.context.find((s): s is Extract<ContextSource, { kind: "memory" }> => s.kind === "memory");
  let memoryTrace: RetrievalTrace | null = null;
  if (memSource) {
    const lastUser = [...c.turns].reverse().find((t) => t.role === "user");
    const queryText = lastUser ? chatStore.activeContent(lastUser) : c.title;
    memoryTrace = retrieveForSource(memSource, queryText, c.projectId);
  }

  return (
    <>
      <Section id="conversation.persona">
      <label className="f">Mode</label>
      <div className="personagrid">
        {PERSONAS.map((p) => (
          <button
            key={p.id}
            className={"personaopt" + (c.personaId === p.id && !c.systemPrompt ? " on" : "")}
            onClick={() => {
              update({ personaId: p.id, systemPrompt: "", temperature: p.temperature ?? c.temperature });
              setCustomPrompt("");
            }}
          >
            <span className="pn">{p.name}</span>
            <span className="pb">{p.blurb}</span>
          </button>
        ))}
      </div>

      <label className="f">Custom instructions — overrides the mode</label>
      <textarea
        className="fi"
        value={customPrompt}
        placeholder={getPersona(c.personaId).prompt.slice(0, 140) + "…"}
        onChange={(e) => setCustomPrompt(e.target.value)}
        onBlur={() => update({ systemPrompt: customPrompt.trim() })}
      />

      </Section>

      <Section id="conversation.model">
      <SelectRow
        title="Backend"
        origin={`from ${originLabel(rBackend.from)}`}
        value={c.backend}
        placeholder={`Inherit (${rBackend.value ? AI.BACKENDS[rBackend.value as BackendType]?.label : "…"})`}
        onChange={(v) => update({ backend: v as BackendType | "", model: "" })}
        options={AI.BACKEND_ORDER.map((id) => ({ value: id, label: AI.BACKENDS[id].label }))}
      />
      <ModelPicker
        title="Model"
        origin={`from ${originLabel(rModel.from)}`}
        value={c.model}
        placeholder={`Inherit (${rModel.value || resolved.backend.defaultModel})`}
        backend={rBackend.value || undefined}
        onChange={(v) => update({ model: v })}
      />
      <SelectRow
        title="Effort"
        origin={`from ${originLabel(rEffort.from)}`}
        value={c.effort}
        placeholder={`Inherit (${rEffort.value})`}
        onChange={(v) => update({ effort: v as Effort | "" })}
        options={[
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" }
        ]}
      />

      {price && (
        <div className="mini-note">
          {formatCost(price.prompt)} per million in · {formatCost(price.completion)} per million out
          {price.contextLength ? ` · ${formatTokens(price.contextLength)} context` : ""}
        </div>
      )}

      </Section>

      <Section id="conversation.sampling">
      <label className="f">Temperature</label>
      <div className="range">
        <input type="range" min={0} max={1} step={0.05} value={c.temperature} onChange={(e) => update({ temperature: parseFloat(e.target.value) })} />
        <span className="rv">{c.temperature.toFixed(2)}</span>
      </div>
      <div className="mini-note">Low is literal and repeatable; high wanders. 0.3 for code, 0.7 to explore.</div>

      <label className="f">Reply limit — tokens</label>
      <input
        className="fi mono"
        type="number"
        min={256}
        max={32000}
        step={256}
        value={c.maxTokens}
        onChange={(e) => update({ maxTokens: Math.max(256, parseInt(e.target.value, 10) || 4096) })}
      />

      </Section>

      <Section id="conversation.context">
      <div className="personagrid">
        <button
          className={"personaopt" + (hasSource((s) => s.kind === "today") ? " on" : "")}
          onClick={() => toggleSource({ kind: "today", days: 1 }, (s) => s.kind === "today")}
        >
          <span className="pn">Today</span>
          <span className="pb">What you reviewed, what you got wrong, what you wrote — the whole day.</span>
        </button>
        <button className={"personaopt" + (hasSource((s) => s.kind === "weak") ? " on" : "")} onClick={() => toggleSource({ kind: "weak", deckId: null }, (s) => s.kind === "weak")}>
          <span className="pn">Your weak spots</span>
          <span className="pb">The cards you keep failing, across every deck.</span>
        </button>
        <button className={"personaopt" + (hasSource((s) => s.kind === "due") ? " on" : "")} onClick={() => toggleSource({ kind: "due", deckId: null }, (s) => s.kind === "due")}>
          <span className="pn">Due today</span>
          <span className="pb">Whatever is up for review right now.</span>
        </button>
        <button className={"personaopt" + (hasSource((s) => s.kind === "notes") ? " on" : "")} onClick={() => toggleSource({ kind: "notes", limit: 25 }, (s) => s.kind === "notes")}>
          <span className="pn">Insight log</span>
          <span className="pb">Your recent notes, in your own words.</span>
        </button>
        <button
          className={"personaopt" + (hasSource((s) => s.kind === "memory") ? " on" : "")}
          onClick={() => toggleSource({ kind: "memory", scope: "both", limit: 8 }, (s) => s.kind === "memory")}
        >
          <span className="pn">Memory</span>
          <span className="pb">What's known about you, scored fresh against each message.</span>
        </button>
        <button className={"personaopt" + (hasSource((s) => s.kind === "knowledge") ? " on" : "")} onClick={() => toggleSource({ kind: "knowledge" }, (s) => s.kind === "knowledge")}>
          <span className="pn">Project files</span>
          <span className="pb">This project's always-attached reference material.</span>
        </button>
        <button
          className={"personaopt" + (hasSource((s) => s.kind === "journal") ? " on" : "")}
          onClick={() => toggleSource({ kind: "journal", days: 14 }, (s) => s.kind === "journal")}
        >
          <span className="pn">Journal</span>
          <span className="pb">The last two weeks of your log.</span>
        </button>
      </div>

      {memSource && (
        <div className="setrow">
          <label className="f">Why these were picked — scored against your last message</label>
          {!memoryTrace || !memoryTrace.picked.length ? (
            <div className="hintline">Nothing scores high enough yet — memory needs a keyword overlap, a pin, or recent use to surface.</div>
          ) : (
            memoryTrace.considered
              .filter((cs) => memoryTrace!.picked.includes(cs.memory))
              .map((cs) => (
                <div key={cs.memory.id} className="hintline">
                  "{cs.memory.text.slice(0, 70)}{cs.memory.text.length > 70 ? "…" : ""}" — {reasonFor(cs.components)}
                </div>
              ))
          )}
        </div>
      )}

      <label className="f">Attach a whole deck</label>
      <select
        className="fi"
        value=""
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          if (!hasSource((s) => s.kind === "deck" && s.deckId === id)) setContext([...c.context, { kind: "deck", deckId: id }]);
        }}
      >
        <option value="">Pick a deck…</option>
        {store.decksOf(c.projectId).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.cards.length})
          </option>
        ))}
      </select>

      {c.context.length > 0 && (
        <>
          <label className="f">Attached</label>
          <div className="att-row">
            {c.context.map((s, i) => (
              <span key={i} className="att-chip">
                {describeSource(s)}
                <span className="x" onClick={() => setContext(c.context.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </span>
              </span>
            ))}
          </div>
        </>
      )}

      </Section>
    </>
  );
}
