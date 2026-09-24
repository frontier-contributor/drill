/* ============================================================================
 * registry.tsx — the one place a settings page is wired to what draws it.
 *
 * Everything a page *says* — its name, its sentence, its groups, the words
 * that find it — lives in `catalogue.ts`, which is pure data and therefore
 * testable. All that is left here is the half that cannot be data: the
 * component to render, and the one label that has to be computed (the space
 * that is not a project is called Personal).
 *
 * Adding a page is two edits, and neither of them can be half-done: an entry
 * in CATEGORY_META with at least one section beside it, and a render call
 * here. `catalogue.test.ts` fails the build if a page has no sections or a
 * section names a page that does not exist.
 * ========================================================================== */
import type { ReactNode } from "react";
import * as store from "@/services/store";
import { isPersonalProject } from "@/services/projects";
import { CATEGORY_META, type CatId, type CategoryMeta } from "./catalogue";
import ProjectScope from "./ProjectScope";
import UsageScope from "./UsageScope";
import ConversationScope from "./ConversationScope";
import Connection from "./sections/Connection";
import ChatPrefs from "./sections/ChatPrefs";
import Voice from "./sections/Voice";
import Listening from "./sections/Listening";
import Memory from "./sections/Memory";
import Review from "./sections/Review";
import Appearance from "./sections/Appearance";
import Data from "./sections/Data";

export type { CatId } from "./catalogue";

export interface Category extends CategoryMeta {
  render: () => ReactNode;
}

const RENDER: Record<CatId, () => ReactNode> = {
  conversation: () => <ConversationScope />,
  connection: () => <Connection />,
  chat: () => <ChatPrefs />,
  voice: () => <Voice />,
  listening: () => <Listening />,
  memory: () => <Memory />,
  review: () => <Review />,
  appearance: () => <Appearance />,
  project: () => <ProjectScope />,
  usage: () => <UsageScope />,
  data: () => <Data />
};

export const CATEGORIES: Category[] = CATEGORY_META.map((c) => ({ ...c, render: RENDER[c.id] }));

/** The name in the rail. Only one page has to compute it, and it reads the
 *  store rather than taking a prop so the rail relabels itself the moment you
 *  switch space behind the open panel. */
export function labelOf(c: { id: CatId; label: string }): string {
  if (c.id === "project" && isPersonalProject(store.get().activeProjectId)) return "Personal";
  return c.label;
}

/** The pages that can actually be rendered here. A page whose scope the
 *  current view does not provide is left out rather than shown empty. */
export function categoriesFor(has: { conversation: boolean }): Category[] {
  return CATEGORIES.filter((c) => c.needs !== "conversation" || has.conversation);
}

export function categoryById(id: CatId | null): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
