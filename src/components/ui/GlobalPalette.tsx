/* ============================================================================
 * GlobalPalette — the command palette, outside chat.
 *
 * The same component chat uses, given the actions that work from anywhere.
 * Its own module so Shell can load it on the first ctrl/cmd+K rather than
 * carry it — and the settings catalogue it reads — in the entry chunk.
 * ========================================================================== */
import CommandPalette from "@/components/chat/CommandPalette";
import { useGlobalActions } from "./globalActions";

export default function GlobalPalette({ onClose }: { onClose: () => void }) {
  const actions = useGlobalActions();
  return <CommandPalette actions={actions} onClose={onClose} />;
}
