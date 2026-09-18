/**
 * Assigns `next` onto an Immer `draft` in place, touching only what changed.
 *
 * `base` is the plain (non-draft) value the draft was created from — the producer's
 * root argument, unchanged since this pass started. When supplied, a key whose value
 * in `next` is reference-identical to the same key in `base` is skipped entirely: the
 * draft already holds that value, so nothing needs to be read from it or written to
 * it. This matters because reading a key of an Immer draft materializes a child draft
 * proxy for that value — on a large keyed collection where most entries are unchanged
 * on most passes, comparing against `base` first avoids descending into every one of
 * them just to discover nothing moved. Without `base`, behavior is unchanged: every
 * key is read and compared against `next` the way it always was.
 */
export function assignDraft<T>(draft: T, next: T, base?: T): T | void {
  if (!isObjectLike(draft) || !isObjectLike(next)) return structuredClone(next);
  if (Array.isArray(draft) || Array.isArray(next)) {
    if (!Array.isArray(draft) || !Array.isArray(next)) return structuredClone(next);
    const baseArray = Array.isArray(base) ? base : undefined;
    draft.length = next.length;
    for (let index = 0; index < next.length; index += 1) {
      if (baseArray && index < baseArray.length && Object.is(baseArray[index], next[index])) {
        continue;
      }
      const replacement = assignDraftValue(draft[index], next[index], baseArray?.[index]);
      if (replacement !== undefined) draft[index] = replacement;
    }
    return;
  }

  const draftRecord = draft as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const baseRecord = isObjectLike(base) ? base : undefined;
  for (const key of Object.keys(draftRecord)) {
    if (!(key in nextRecord)) delete draftRecord[key];
  }
  for (const [key, incoming] of Object.entries(nextRecord)) {
    if (baseRecord && key in baseRecord && Object.is(baseRecord[key], incoming)) continue;
    const replacement = assignDraftValue(draftRecord[key], incoming, baseRecord?.[key]);
    if (replacement !== undefined) draftRecord[key] = replacement;
  }
}

function assignDraftValue(
  current: unknown,
  incoming: unknown,
  base?: unknown
): unknown | undefined {
  if (Object.is(current, incoming)) return undefined;
  if (isObjectLike(current) && isObjectLike(incoming)) {
    const replacement = assignDraft(current, incoming, base as never);
    return replacement === undefined ? undefined : replacement;
  }
  return incoming;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
