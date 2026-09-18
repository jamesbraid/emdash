import { ManualClock } from '@emdash/shared/testing';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TempStoreHandle } from '#primitives/sqlite-store/api';
import type { DurableWorkspaceRecord } from './persistence/record-store';
import { WorkspaceRecordStore } from './persistence/record-store';
import { workspaceRegistryStore, type WorkspaceRegistryDb } from './persistence/store';
import { WorkspaceRegistryRuntime } from './runtime';
import type { WorkspaceScriptRunner } from './scripts-plane';

// isWorkspaceActive answers the scan scheduler's per-target activity question on every
// watch reconcile (spec: registry-runtime-per-change-cost). On a large registry that
// used to mean one SQLite SELECT per present record per reconcile; these tests pin the
// fix at the seam that matters — the answer comes from memory, not the store — and that
// its two truth conditions (a fresh/active overlay, a durable activation inside the
// 60-minute window) still hold.

function repositoryRecord(
  id: string,
  overrides: Partial<DurableWorkspaceRecord> = {}
): DurableWorkspaceRecord {
  return {
    id,
    kind: 'repository',
    path: `/tmp/${id}`,
    parentId: null,
    origin: 'registered',
    gitAdminName: null,
    observedStatus: 'present',
    creation: null,
    lastCreateOutcome: null,
    lifecycle: null,
    lastRemovalAttempt: null,
    git: null,
    lastActivatedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastObservedAt: 0,
    ...overrides,
  };
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe('WorkspaceRegistryRuntime#isWorkspaceActive', () => {
  let handle: TempStoreHandle<WorkspaceRegistryDb, Database.Database>;
  let runtime: WorkspaceRegistryRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    handle?.close();
    runtime = undefined;
  });

  it('answers a 300-record registry with zero SQLite statements, before and after a save', async () => {
    handle = await workspaceRegistryStore.openTemp();
    const seed = new WorkspaceRecordStore(handle);
    const ids = Array.from({ length: 300 }, (_, index) => `ws-${index}`);
    for (const id of ids) seed.insert(repositoryRecord(id));

    const clock = new ManualClock(10_000);
    runtime = new WorkspaceRegistryRuntime({ handle, clock });

    // One real save — activation persists lastActivatedAt through the same publish()
    // path a scan-driven saveRecord() uses.
    const activated = await runtime.activateWorkspace({ workspaceId: ids[0]! });
    expect(activated.success).toBe(true);

    const prepare = vi.spyOn(handle.connection.native, 'prepare');
    for (const id of ids) runtime.isWorkspaceActive(id);
    // The scheduler's reconcile loop calls this once per present target; on a
    // registry this size that used to be 300 SELECTs (spec evidence: RecordStore.get
    // 34.9%, drizzle _prepare 32.2%). It must now be none.
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('is true only inside the 60-minute window after a durable activation', async () => {
    handle = await workspaceRegistryStore.openTemp();
    const seed = new WorkspaceRecordStore(handle);
    seed.insert(repositoryRecord('ws-1'));

    const clock = new ManualClock(10_000);
    runtime = new WorkspaceRegistryRuntime({ handle, clock });

    expect(runtime.isWorkspaceActive('ws-1')).toBe(false);

    const activated = await runtime.activateWorkspace({ workspaceId: 'ws-1' });
    expect(activated.success).toBe(true);
    expect(runtime.isWorkspaceActive('ws-1')).toBe(true);

    // The in-session overlay stays truthy until deactivation regardless of the clock;
    // clear it so what remains is purely the durable lastActivatedAt window — the
    // grace period a restarted daemon (empty overlay map, durable record only) relies
    // on to keep a recently-active workspace scanning eagerly.
    await runtime.deactivateWorkspace({ workspaceId: 'ws-1' });
    expect(runtime.isWorkspaceActive('ws-1')).toBe(true);

    await clock.advanceBy(59 * 60_000);
    expect(runtime.isWorkspaceActive('ws-1')).toBe(true);

    await clock.advanceBy(2 * 60_000);
    expect(runtime.isWorkspaceActive('ws-1')).toBe(false);
  });

  it('is true while an activation is in flight, before lastActivatedAt is ever persisted', async () => {
    handle = await workspaceRegistryStore.openTemp();
    const seed = new WorkspaceRecordStore(handle);
    seed.insert(repositoryRecord('ws-1'));
    seed.updatePersonalConfig('ws-1', { scripts: { prepare: 'noop' } });

    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runner: WorkspaceScriptRunner = {
      run: async (input) => {
        if (input.id === 'prepare') await gate;
        return { status: 'succeeded', outputTail: '' };
      },
    };

    const clock = new ManualClock(10_000);
    runtime = new WorkspaceRegistryRuntime({ handle, clock, activation: { runner } });

    expect(runtime.isWorkspaceActive('ws-1')).toBe(false);
    const activating = runtime.activateWorkspace({ workspaceId: 'ws-1' });

    // Prepare is gated: activation is under way (overlay set) but the durable
    // lastActivatedAt column has not been written yet — only the overlay can explain
    // this being true.
    await eventually(() => {
      expect(runtime!.isWorkspaceActive('ws-1')).toBe(true);
    });

    releaseGate();
    const activated = await activating;
    expect(activated.success).toBe(true);
    // Now durable too — still true, this time from the persisted window.
    expect(runtime.isWorkspaceActive('ws-1')).toBe(true);
  });

  it('stops answering true for a deleted workspace', async () => {
    handle = await workspaceRegistryStore.openTemp();
    const seed = new WorkspaceRecordStore(handle);
    seed.insert(repositoryRecord('ws-1'));

    const clock = new ManualClock(10_000);
    runtime = new WorkspaceRegistryRuntime({ handle, clock });

    const activated = await runtime.activateWorkspace({ workspaceId: 'ws-1' });
    expect(activated.success).toBe(true);
    expect(runtime.isWorkspaceActive('ws-1')).toBe(true);

    await runtime.deactivateWorkspace({ workspaceId: 'ws-1' });
    const deleted = await runtime.deleteWorkspace({ workspaceId: 'ws-1' });
    expect(deleted.success).toBe(true);
    expect(runtime.isWorkspaceActive('ws-1')).toBe(false);
  });
});
