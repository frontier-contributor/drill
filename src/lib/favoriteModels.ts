/* ============================================================================
 * favoriteModels.ts — the models you pinned to the top of every picker.
 *
 * Recents answer "what did I use last"; this answers "what do I always want
 * within reach", which is a different list — the model you reach for once a
 * week for a hard derivation is never recent and always wanted. Global, like
 * recents, and for the same reason: it is a habit, not a property of a thread.
 *
 * A handful of ids in localStorage. It has the subscribe shape so a star
 * pressed in one picker is lit in the next one opened.
 * ========================================================================== */
const KEY = "drill:favoriteModels:v1";
const MAX = 24;

let version = 0;
const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVersion(): number {
  return version;
}

export function favoriteModels(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && !!x) : [];
  } catch {
    return [];
  }
}

export function isFavorite(id: string): boolean {
  return favoriteModels().includes(id);
}

export function toggleFavorite(id: string): boolean {
  const list = favoriteModels();
  const on = !list.includes(id);
  const next = on ? [id, ...list].slice(0, MAX) : list.filter((x) => x !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a star is a nicety; the picker still works without it */
  }
  version++;
  listeners.forEach((l) => l());
  return on;
}
