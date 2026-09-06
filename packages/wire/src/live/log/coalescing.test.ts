import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveLogSource } from './source';

describe('LiveLogSource output coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits one update per flush window instead of one per append', () => {
    const source = new LiveLogSource({ generation: 1, coalesceMs: 16 });
    const updates: Array<{ sequence: number; delta: unknown }> = [];
    source.subscribe((update) => updates.push({ sequence: update.sequence, delta: update.delta }));

    source.append('a');
    source.append('b');
    source.append('c');
    expect(updates).toEqual([]);

    vi.advanceTimersByTime(16);
    expect(updates).toEqual([{ sequence: 1, delta: { chunk: 'abc' } }]);
  });

  it('retains appended text immediately and flushes before answering a snapshot', () => {
    const source = new LiveLogSource({ generation: 1, coalesceMs: 16 });
    const updates: number[] = [];
    source.subscribe((update) => updates.push(update.sequence));

    source.append('hello');
    const snapshot = source.snapshot();

    // The snapshot already carries the text, and the pending update went out
    // first, so a client seeded from this snapshot never sees it twice.
    expect(snapshot.data.text).toBe('hello');
    expect(updates).toEqual([1]);
    expect(snapshot.sequence).toBe(1);
    vi.advanceTimersByTime(16);
    expect(updates).toEqual([1]);
  });

  it('flushes early once pending output passes the byte cap', () => {
    const source = new LiveLogSource({ generation: 1, coalesceMs: 16, coalesceMaxBytes: 8 });
    const chunks: string[] = [];
    source.subscribe((update) => chunks.push((update.delta as { chunk: string }).chunk));

    source.append('12345');
    expect(chunks).toEqual([]);
    source.append('6789');
    expect(chunks).toEqual(['123456789']);
  });

  it('flush() delivers pending output on demand', () => {
    const source = new LiveLogSource({ generation: 1, coalesceMs: 16 });
    const chunks: string[] = [];
    source.subscribe((update) => chunks.push((update.delta as { chunk: string }).chunk));

    source.append('tail');
    source.flush();
    expect(chunks).toEqual(['tail']);
    vi.advanceTimersByTime(16);
    expect(chunks).toEqual(['tail']);
  });

  it('emits pending text under the old generation before a reseed starts a new one', () => {
    const source = new LiveLogSource({ generation: 1000, coalesceMs: 16 });
    const updates: Array<{ generation: number; sequence: number; chunk: string }> = [];
    source.subscribe((update) =>
      updates.push({
        generation: update.generation,
        sequence: update.sequence,
        chunk: (update.delta as { chunk: string }).chunk,
      })
    );

    source.append('old tail');
    source.reseed();
    expect(updates).toEqual([{ generation: 1000, sequence: 1, chunk: 'old tail' }]);
    vi.advanceTimersByTime(16);
    expect(updates).toHaveLength(1);

    const snapshot = source.snapshot();
    expect(snapshot.generation).toBeGreaterThan(1000);
    expect(snapshot.sequence).toBe(0);
    expect(snapshot.data.text).toBe('');

    source.append('new');
    vi.advanceTimersByTime(16);
    expect(updates).toEqual([
      { generation: 1000, sequence: 1, chunk: 'old tail' },
      { generation: snapshot.generation, sequence: 1, chunk: 'new' },
    ]);
  });

  it('keeps the default source emitting per append', () => {
    const source = new LiveLogSource({ generation: 1 });
    const chunks: string[] = [];
    source.subscribe((update) => chunks.push((update.delta as { chunk: string }).chunk));

    source.append('a');
    source.append('b');
    expect(chunks).toEqual(['a', 'b']);
  });
});
