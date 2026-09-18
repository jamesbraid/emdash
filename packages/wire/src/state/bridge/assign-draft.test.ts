import { describe, expect, it } from 'vitest';
import { assignDraft } from './assign-draft';

// assignDraft's cost on a large keyed collection is dominated by reading keys off the
// Immer draft: a read materializes a child draft proxy for that value even when
// nothing changed. These tests stand in for that cost with a Proxy that records every
// `get`, so they pin the behavior that matters without pulling in real Immer — skip a
// key entirely when `base` says it is unchanged, and behave exactly as before when
// `base` is absent.

function trackReads<T extends object>(target: T): { proxy: T; reads: PropertyKey[] } {
  const reads: PropertyKey[] = [];
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      reads.push(prop);
      return Reflect.get(obj, prop, receiver);
    },
  });
  return { proxy, reads };
}

describe('assignDraft', () => {
  it('with a base, never reads a key whose value is unchanged, and applies changed ones', () => {
    const unchangedNested = { x: 1 };
    const changedNestedOld = { y: 2 };
    const base: Record<string, unknown> = {
      a: unchangedNested,
      b: changedNestedOld,
      c: 'same',
      d: 'old',
    };
    // A draft always starts out equal to base — same references, mutable in place,
    // exactly what produce() hands a mutator.
    const draftTarget: Record<string, unknown> = { ...base };
    const { proxy: draft, reads } = trackReads(draftTarget);

    const next: Record<string, unknown> = {
      a: unchangedNested, // same reference as base.a — must not be read
      b: { y: 3 }, // different reference — must be read and applied
      c: 'same', // same value as base.c — must not be read
      d: 'new', // different value — must be read and applied
    };

    const result = assignDraft(draft, next, base);

    expect(result).toBeUndefined();
    expect(reads).not.toContain('a');
    expect(reads).not.toContain('c');
    expect(reads).toContain('b');
    expect(reads).toContain('d');
    expect(draftTarget).toEqual(structuredClone(next));
  });

  it('without a base, reads every key — unchanged from before this change', () => {
    const shared = { x: 1 };
    const draftTarget: Record<string, unknown> = { a: shared, b: 'same' };
    const { proxy: draft, reads } = trackReads(draftTarget);
    const next: Record<string, unknown> = { a: shared, b: 'same' };

    assignDraft(draft, next);

    expect(reads).toContain('a');
    expect(reads).toContain('b');
  });

  it('threads base into nested records so an unchanged grandchild is skipped too', () => {
    const untouchedLeaf = { value: 'leaf' };
    const base = { outer: { untouched: untouchedLeaf, touched: 'old' } };
    const outerDraftTarget: Record<string, unknown> = { untouched: untouchedLeaf, touched: 'old' };
    const { proxy: outerDraft, reads: outerReads } = trackReads(outerDraftTarget);
    const draftTarget = { outer: outerDraft };

    const next = { outer: { untouched: untouchedLeaf, touched: 'new' } };

    assignDraft(draftTarget, next, base);

    expect(outerReads).not.toContain('untouched');
    expect(outerReads).toContain('touched');
    expect(outerDraftTarget).toEqual({ untouched: untouchedLeaf, touched: 'new' });
  });

  it('still deletes a key absent from next, with or without a base', () => {
    const base: Record<string, unknown> = { a: 1, b: 2 };
    const draftTarget: Record<string, unknown> = { ...base };
    const next: Record<string, unknown> = { a: 1 };

    assignDraft(draftTarget, next, base);

    expect(draftTarget).toEqual({ a: 1 });
  });

  it('skips an unchanged array index against base without reading it', () => {
    const kept = { id: 1 };
    const base: unknown[] = [kept, { id: 2 }];
    const draftTarget: unknown[] = [kept, { id: 2 }];
    const { proxy: draft, reads } = trackReads(draftTarget as unknown as Record<string, unknown>);
    const next: unknown[] = [kept, { id: 3 }];

    assignDraft(draft as unknown as unknown[], next, base);

    expect(reads).not.toContain('0');
    expect(reads).toContain('1');
    expect(draftTarget).toEqual(next);
  });
});
