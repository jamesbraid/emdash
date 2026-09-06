import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyProcess } from '#services/pty/testing';
import { PtySession } from './pty-session';
import type { PtySpawnSpec } from './types';

const spec: PtySpawnSpec = {
  invocation: { kind: 'argv', executable: 'claude', argv: [] },
  cwd: '/tmp',
  env: { PATH: '/bin' },
  cols: 120,
  rows: 30,
};

describe('PtySession output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid pty output into one live update per flush window', () => {
    const proc = new FakePtyProcess(1);
    const onData = vi.fn();
    const session = new PtySession('k', spec, proc, { onData });
    const chunks: string[] = [];
    session.output.subscribe((update) => chunks.push((update.delta as { chunk: string }).chunk));

    proc.emitData('\x1b[2K');
    proc.emitData('prompt> ');
    proc.emitData('x');

    // Raw chunks still drive activity tracking, but subscribers get one update.
    expect(onData).toHaveBeenCalledTimes(3);
    expect(chunks).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(chunks).toEqual(['\x1b[2Kprompt> x']);
    expect(session.output.snapshot().data.text).toBe('\x1b[2Kprompt> x');
  });

  it('delivers pending output before reporting exit', () => {
    const proc = new FakePtyProcess(1);
    const order: string[] = [];
    const session = new PtySession('k', spec, proc, {
      onExit: () => order.push('exit'),
    });
    session.output.subscribe(() => order.push('output'));

    proc.emitData('bye');
    proc.emitExit({ exitCode: 0, signal: null });

    expect(order).toEqual(['output', 'exit']);
  });
});
