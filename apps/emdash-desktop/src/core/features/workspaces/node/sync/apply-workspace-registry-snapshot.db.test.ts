import type {
  WorkspaceRecord,
  WorkspaceRecords,
} from '@emdash/core/runtimes/workspace-registry/api';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceRegistry,
  workspaceObservationFromRecord,
  workspaceRegistryTable,
} from '@core/features/workspaces/api/node/registry';
import { appDbPokes, type WorkspacePoke } from '@core/services/app-db/node/pokes';
import type { WorkspaceRow } from '@core/services/app-db/node/schema';
import {
  applyWorkspaceRegistrySnapshot,
  WorkspaceIdentityConflictError,
} from './apply-workspace-registry-snapshot';

const LOCAL_HOST = { location: 'local', sshConnectionId: null } as const;

/** Distinct epoch-ms observation stamps, one per delivery. */
function stamp(delivery: number): number {
  return Date.parse('2026-02-01T00:00:00.000Z') + delivery * 3_600_000;
}

function hostRecord(overrides: Partial<WorkspaceRecord> & { id: string }): WorkspaceRecord {
  return {
    kind: 'worktree',
    path: `/worktrees/${overrides.id}`,
    parentId: 'ws-repo',
    origin: 'registered',
    gitAdminName: overrides.id,
    observedStatus: 'present',
    creation: null,
    lastCreateOutcome: null,
    lastRemovalAttempt: null,
    lifecycle: null,
    git: {
      branch: 'feature/x',
      dirty: true,
      diffStats: { added: 12, deleted: 3 },
      ahead: 1,
      behind: 0,
      locked: false,
      prunable: false,
      headOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      upstream: {
        remote: 'origin',
        mergeRef: 'refs/heads/feature/x',
        remoteUrl: 'https://example.com/acme/app.git',
      },
      prBreadcrumb: 'https://github.com/acme/app/pull/7',
    },
    lastActivatedAt: null,
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    lastObservedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    config: null,
    runtime: null,
    ...overrides,
  };
}

/**
 * Convergence from the workspace registry `records` live model (ADR 0005). The mirror
 * is never the authority: deliveries overwrite observation columns wholesale (git
 * block, create outcome, runtime overlay included) and never touch annotations; the
 * sweep follows the missing rules and is scoped to the delivering host.
 */
describe('applyWorkspaceRegistrySnapshot', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
  });

  afterEach(() => {
    fixture.close();
  });

  function seedTask(projectId: string, taskId: string, workspaceId: string): void {
    fixture.sqlite
      .prepare(`INSERT INTO projects (id, name) VALUES (?, ?)`)
      .run(projectId, `project-${projectId}`);
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status, workspace_id)
         VALUES (?, ?, ?, 'running', ?)`
      )
      .run(taskId, projectId, `task-${taskId}`, workspaceId);
  }

  it('adopts unknown host records with observations populated (wiped-client reconvergence)', async () => {
    const result = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {
        'ws-repo': hostRecord({
          id: 'ws-repo',
          kind: 'repository',
          path: '/repos/app',
          parentId: null,
          gitAdminName: null,
        }),
        'wt-1': hostRecord({
          id: 'wt-1',
          lastCreateOutcome: { status: 'succeeded', at: Date.parse('2026-01-01T12:00:00.000Z') },
        }),
      },
      observedAt: Date.parse('2026-01-03T00:00:00.000Z'),
    });

    expect(result).toEqual({
      adopted: 2,
      refreshed: 0,
      unchanged: 0,
      markedMissing: 0,
      untracked: 0,
      purgedTombstones: 0,
    });

    const registry = createWorkspaceRegistry(fixture.db);
    expect(registry.getLive('wt-1')).toMatchObject({
      origin: 'registered',
      kind: 'worktree',
      path: '/worktrees/wt-1',
      parentId: 'ws-repo',
      config: null,
      observedStatus: 'present',
      observedGit: {
        version: '2',
        branch: 'feature/x',
        dirty: true,
        diffStats: { added: 12, deleted: 3 },
        headOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        upstream: {
          remote: 'origin',
          mergeRef: 'refs/heads/feature/x',
          remoteUrl: 'https://example.com/acme/app.git',
        },
        prBreadcrumb: 'https://github.com/acme/app/pull/7',
      },
      lastCreateOutcome: { version: '1', status: 'succeeded' },
      runtimeOverlay: null,
      observedAt: Date.parse('2026-01-03T00:00:00.000Z'),
      location: 'local',
      sshConnectionId: null,
    });

    // Reconvergence is idempotent: a replayed snapshot refreshes instead of duplicating.
    const replay = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {
        'ws-repo': hostRecord({ id: 'ws-repo', kind: 'repository', parentId: null }),
        'wt-1': hostRecord({ id: 'wt-1' }),
      },
    });
    expect(replay).toEqual({
      adopted: 0,
      refreshed: 2,
      unchanged: 0,
      markedMissing: 0,
      untracked: 0,
      purgedTombstones: 0,
    });
  });

  it('treats a stored v1 observedGit payload as not yet observed and rewrites it as v2', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.recordCreationIntent({
      id: 'wt-1',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/worktrees/wt-1',
    });
    // The exact JSON a pre-v2 desktop stored: version '1', none of the v2 fields.
    // No upcast exists by design — observations are re-derived by the next scan.
    fixture.sqlite.prepare(`UPDATE workspaces SET observed_git = ? WHERE id = 'wt-1'`).run(
      JSON.stringify({
        version: '1',
        branch: 'feature/x',
        dirty: true,
        diffStats: null,
        ahead: null,
        behind: null,
        locked: false,
        prunable: false,
      })
    );

    expect(registry.getLive('wt-1')?.observedGit).toBeNull();

    // The next delivery persists the v2 payload wholesale.
    await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: { 'wt-1': hostRecord({ id: 'wt-1' }) },
    });
    expect(registry.getLive('wt-1')?.observedGit).toMatchObject({
      version: '2',
      branch: 'feature/x',
      headOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      upstream: { remote: 'origin' },
      prBreadcrumb: 'https://github.com/acme/app/pull/7',
    });
  });

  it('overwrites observations wholesale — overlay included — but never touches annotations', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.recordCreationIntent({
      id: 'wt-1',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/worktrees/wt-1',
      config: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    });

    const withOverlay = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {
        'wt-1': hostRecord({
          id: 'wt-1',
          runtime: {
            creation: null,
            notices: [],
            activation: {
              phase: 'active',
              scripts: { prepare: 'succeeded', setup: 'running', run: 'pending' },
              activatedAt: Date.parse('2026-01-05T00:00:00.000Z'),
            },
          },
          lastActivatedAt: Date.parse('2026-01-05T00:00:00.000Z'),
        }),
      },
    });
    expect(withOverlay).toEqual({
      adopted: 0,
      refreshed: 1,
      unchanged: 0,
      markedMissing: 0,
      untracked: 0,
      purgedTombstones: 0,
    });
    expect(registry.getLive('wt-1')).toMatchObject({
      observedGit: { branch: 'feature/x', diffStats: { added: 12, deleted: 3 } },
      lastActivatedAt: Date.parse('2026-01-05T00:00:00.000Z'),
      runtimeOverlay: { version: '1', activation: { phase: 'active' } },
      // The rich-provenance annotation is client-owned; the snapshot cannot touch it.
      config: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    });

    // A daemon restart delivers runtime null — the persisted overlay column clears.
    await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: { 'wt-1': hostRecord({ id: 'wt-1', runtime: null }) },
    });
    expect(registry.getLive('wt-1')).toMatchObject({ runtimeOverlay: null });
  });

  it('carries removal attempts and script outcomes into the mirror observation columns', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.recordCreationIntent({
      id: 'wt-1',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/worktrees/wt-1',
    });

    await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {
        'wt-1': hostRecord({
          id: 'wt-1',
          lastRemovalAttempt: {
            stage: 'remove',
            class: 'terminal',
            message: 'worktree is locked',
            at: Date.parse('2026-01-06T00:00:00.000Z'),
          },
          runtime: {
            creation: null,
            notices: [],
            activation: null,
            lifecycle: [
              {
                id: 'setup',
                status: 'failed',
                startedAt: Date.parse('2026-01-05T00:00:00.000Z'),
                finishedAt: Date.parse('2026-01-05T00:00:01.000Z'),
                message: 'exit 3',
                params: {},
              },
            ],
          },
        }),
      },
    });
    expect(registry.getLive('wt-1')).toMatchObject({
      lastRemovalAttempt: {
        version: '1',
        stage: 'remove',
        class: 'terminal',
        message: 'worktree is locked',
      },
      runtimeOverlay: {
        version: '1',
        lifecycle: [expect.objectContaining({ id: 'setup', status: 'failed' })],
      },
    });

    // Wholesale refresh: a delivery without the blocks clears the columns.
    await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: { 'wt-1': hostRecord({ id: 'wt-1' }) },
    });
    expect(registry.getLive('wt-1')).toMatchObject({
      lastRemovalAttempt: null,
      runtimeOverlay: null,
    });
  });

  it('sweeps unmatched rows: annotated go visible-missing, pure mirror rows untrack', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.recordCreationIntent({
      id: 'wt-linked',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/worktrees/linked',
      config: null,
    });
    seedTask('project-1', 'task-1', 'wt-linked');
    registry.adopt({
      id: 'wt-mirror',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/worktrees/mirror',
    });

    const result = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {},
      observedAt: Date.parse('2026-01-07T00:00:00.000Z'),
    });

    expect(result).toEqual({
      adopted: 0,
      refreshed: 0,
      unchanged: 0,
      markedMissing: 1,
      untracked: 1,
      purgedTombstones: 0,
    });
    expect(registry.getLive('wt-linked')).toMatchObject({
      observedStatus: 'missing',
      observedAt: Date.parse('2026-01-07T00:00:00.000Z'),
    });
    expect(registry.getLive('wt-mirror')).toBeUndefined();

    // Still absent on the next delivery: the stamp moves, nothing is re-marked.
    const again = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {},
      observedAt: Date.parse('2026-01-08T00:00:00.000Z'),
    });
    expect(again).toEqual({
      adopted: 0,
      refreshed: 0,
      unchanged: 1,
      markedMissing: 0,
      untracked: 0,
      purgedTombstones: 0,
    });
    expect(registry.getLive('wt-linked')).toMatchObject({
      observedStatus: 'missing',
      observedAt: Date.parse('2026-01-08T00:00:00.000Z'),
    });
  });

  it('purges a tombstoned row once the delivery confirms the record gone — annotation included', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.recordCreationIntent({
      id: 'wt-doomed',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/worktrees/doomed',
    });
    // Annotated (task-linked) rows normally stay visible as missing; a deletion
    // tombstone overrides that — the user already asked for the row to go.
    seedTask('project-1', 'task-1', 'wt-doomed');
    registry.tombstone('wt-doomed', {
      version: '1',
      targetRecordId: 'wt-doomed',
      tombstonedAt: Date.parse('2026-01-06T00:00:00.000Z'),
      options: { deleteBranch: true, deleteConversations: false },
    });

    // While the record is still delivered, the tombstoned row refreshes and waits.
    const pending = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: { 'wt-doomed': hostRecord({ id: 'wt-doomed', path: '/worktrees/doomed' }) },
    });
    expect(pending).toEqual({
      adopted: 0,
      refreshed: 1,
      unchanged: 0,
      markedMissing: 0,
      untracked: 0,
      purgedTombstones: 0,
    });
    expect(registry.getLive('wt-doomed')?.deletionTombstone).toMatchObject({
      targetRecordId: 'wt-doomed',
    });

    // The record disappears from the delivery: mirror-confirmed gone, purge.
    const purged = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {},
    });
    expect(purged).toEqual({
      adopted: 0,
      refreshed: 0,
      unchanged: 0,
      markedMissing: 0,
      untracked: 0,
      purgedTombstones: 1,
    });
    expect(registry.getLive('wt-doomed')).toBeUndefined();
  });

  it('scopes the sweep to the snapshot host; other hosts are untouched', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    fixture.sqlite
      .prepare(
        `INSERT INTO ssh_connections (id, name, host, port, username, auth_type)
         VALUES ('ssh-1', 'box', 'box.example', 22, 'dev', 'agent')`
      )
      .run();
    registry.adopt({
      id: 'wt-remote',
      type: 'project-ssh',
      kind: 'worktree',
      location: 'remote',
      sshConnectionId: 'ssh-1',
      path: '/remote/worktree',
      observedStatus: 'present',
    });

    const result = await applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {},
    });

    expect(result).toEqual({
      adopted: 0,
      refreshed: 0,
      unchanged: 0,
      markedMissing: 0,
      untracked: 0,
      purgedTombstones: 0,
    });
    expect(registry.getLive('wt-remote')).toMatchObject({ observedStatus: 'present' });
  });

  it('rejects an id/path collision before adopting, refreshing, or sweeping anything', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.recordCreationIntent({
      id: 'desktop-id',
      type: 'local',
      kind: 'repository',
      location: 'local',
      path: '/repo',
      observedStatus: 'present',
    });
    registry.adopt({
      id: 'would-be-swept',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/work/old',
      observedStatus: 'present',
    });

    const application = applyWorkspaceRegistrySnapshot({
      db: fixture.db,
      host: LOCAL_HOST,
      records: {
        'host-id': hostRecord({
          id: 'host-id',
          kind: 'repository',
          path: '/repo',
          parentId: null,
        }),
      },
    });

    await expect(application).rejects.toMatchObject({
      name: 'WorkspaceIdentityConflictError',
      path: '/repo',
      incomingId: 'host-id',
      conflictingId: 'desktop-id',
    });
    expect(registry.getLive('host-id')).toBeUndefined();
    expect(registry.getLive('desktop-id')).toMatchObject({
      path: '/repo',
      observedStatus: 'present',
    });
    expect(registry.getLive('would-be-swept')).toMatchObject({
      path: '/work/old',
      observedStatus: 'present',
    });
  });

  it('rejects a Windows casing collision before changing the mirror', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.recordCreationIntent({
      id: 'desktop-id',
      type: 'local',
      kind: 'repository',
      location: 'local',
      path: 'C:\\Repo',
      observedStatus: 'present',
    });

    await expect(
      applyWorkspaceRegistrySnapshot({
        db: fixture.db,
        host: LOCAL_HOST,
        records: {
          'host-id': hostRecord({
            id: 'host-id',
            kind: 'repository',
            path: 'c:\\REPO',
            parentId: null,
          }),
        },
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceIdentityConflictError',
      incomingId: 'host-id',
      conflictingId: 'desktop-id',
    });
    expect(registry.getLive('desktop-id')?.path).toBe('C:\\Repo');
    expect(registry.getLive('host-id')).toBeUndefined();
  });

  it('rejects duplicate Host path ownership even when neither id exists locally', async () => {
    await expect(
      applyWorkspaceRegistrySnapshot({
        db: fixture.db,
        host: LOCAL_HOST,
        records: {
          first: hostRecord({ id: 'first', path: '/same' }),
          second: hostRecord({ id: 'second', path: '/same' }),
        },
      })
    ).rejects.toBeInstanceOf(WorkspaceIdentityConflictError);
    expect(createWorkspaceRegistry(fixture.db).getLive('first')).toBeUndefined();
    expect(createWorkspaceRegistry(fixture.db).getLive('second')).toBeUndefined();
  });

  it('applies a valid path swap without depending on snapshot record order', async () => {
    const registry = createWorkspaceRegistry(fixture.db);
    registry.adopt({
      id: 'first',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/first',
    });
    registry.adopt({
      id: 'second',
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: '/second',
    });

    await expect(
      applyWorkspaceRegistrySnapshot({
        db: fixture.db,
        host: LOCAL_HOST,
        records: {
          first: hostRecord({ id: 'first', path: '/second' }),
          second: hostRecord({ id: 'second', path: '/first' }),
        },
      })
    ).resolves.toMatchObject({ refreshed: 2 });
    expect(registry.getLive('first')).toMatchObject({ path: '/second' });
    expect(registry.getLive('second')).toMatchObject({ path: '/first' });
  });

  /**
   * The host re-delivers its full record map on every change, several times a second
   * while agents work. Rows whose observation did not change must cost one batched
   * timestamp stamp, not a read-and-rewrite each.
   */
  describe('unchanged rows', () => {
    function snapshotOf(worktrees: number): WorkspaceRecords {
      const records: Record<string, WorkspaceRecord> = {
        'ws-repo': hostRecord({
          id: 'ws-repo',
          kind: 'repository',
          path: '/repos/app',
          parentId: null,
          gitAdminName: null,
        }),
      };
      for (let index = 0; index < worktrees; index += 1) {
        records[`wt-${index}`] = hostRecord({ id: `wt-${index}` });
      }
      return records;
    }

    function apply(records: WorkspaceRecords, observedAt: number) {
      return applyWorkspaceRegistrySnapshot({
        db: fixture.db,
        host: LOCAL_HOST,
        records,
        observedAt,
      });
    }

    function liveRows(): WorkspaceRow[] {
      return fixture.db
        .select()
        .from(workspaceRegistryTable)
        .all()
        .sort((left, right) => left.id.localeCompare(right.id));
    }

    /** Everything but the stamps, which are expected to move on every delivery. */
    function observation(row: WorkspaceRow) {
      const { observedAt: _observedAt, updatedAt: _updatedAt, ...columns } = row;
      return columns;
    }

    /** Statement kinds prepared while `run` executes, transaction bookkeeping excluded. */
    async function statementsDuring<T>(
      run: () => Promise<T>
    ): Promise<{ result: T; statements: Record<string, number> }> {
      const prepare = vi.spyOn(fixture.sqlite, 'prepare');
      try {
        const result = await run();
        const statements: Record<string, number> = {};
        for (const [sql] of prepare.mock.calls) {
          const kind = String(sql).trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
          if (kind === 'BEGIN' || kind === 'COMMIT' || kind === 'ROLLBACK') continue;
          statements[kind] = (statements[kind] ?? 0) + 1;
        }
        return { result, statements };
      } finally {
        prepare.mockRestore();
      }
    }

    it('re-delivers an identical snapshot in a fixed number of statements, moving only observedAt', async () => {
      const small = snapshotOf(3);
      await apply(small, stamp(1));
      const { statements: smallStatements } = await statementsDuring(() => apply(small, stamp(2)));

      const large = snapshotOf(40);
      await apply(large, stamp(3));
      const before = liveRows();
      const { result, statements } = await statementsDuring(() => apply(large, stamp(4)));

      expect(result).toEqual({
        adopted: 0,
        refreshed: 0,
        unchanged: 41,
        markedMissing: 0,
        untracked: 0,
        purgedTombstones: 0,
      });
      // Host rows, the two annotation lookups, tombstones; then one batched stamp.
      expect(statements).toEqual({ SELECT: 4, UPDATE: 1 });
      expect(statements).toEqual(smallStatements);
      const after = liveRows();
      expect(after.map(observation)).toEqual(before.map(observation));
      expect(after.map((row) => row.observedAt)).toEqual(after.map(() => stamp(4)));
    });

    it('refreshes exactly the rows whose observation changed', async () => {
      const records = snapshotOf(5);
      await apply(records, stamp(1));
      const before = liveRows();
      const base = hostRecord({ id: 'wt-2' });
      const changedRecord: WorkspaceRecord = {
        ...base,
        git: base.git === null ? null : { ...base.git, dirty: false },
      };
      const changed: WorkspaceRecords = { ...records, 'wt-2': changedRecord };

      const { result, statements } = await statementsDuring(() => apply(changed, stamp(2)));

      expect(result).toEqual({
        adopted: 0,
        refreshed: 1,
        unchanged: 5,
        markedMissing: 0,
        untracked: 0,
        purgedTombstones: 0,
      });
      // On top of the identical-redelivery reads (host rows, the two annotation lookups,
      // tombstones) the changed row pays for refresh's own reads and its write, plus the
      // two lookups that map changed rows to the projects to poke. Refresh's read count
      // is measured directly so this holds whatever refresh needs to check.
      const registry = createWorkspaceRegistry(fixture.db);
      const { statements: refreshStatements } = await statementsDuring(async () => {
        registry.refresh(
          'wt-2',
          workspaceObservationFromRecord(changedRecord, LOCAL_HOST, stamp(2))
        );
      });
      expect(refreshStatements['UPDATE']).toBe(1);
      expect(statements).toEqual({ SELECT: 4 + (refreshStatements['SELECT'] ?? 0) + 2, UPDATE: 2 });
      const after = liveRows();
      expect(after.find((row) => row.id === 'wt-2')?.observedGit).toMatchObject({ dirty: false });
      const others = (rows: WorkspaceRow[]) =>
        rows.filter((row) => row.id !== 'wt-2').map(observation);
      expect(others(after)).toEqual(others(before));
      expect(after.map((row) => row.observedAt)).toEqual(after.map(() => stamp(2)));
    });

    it('treats a Host respelling of the stored path as unchanged and keeps the stored display', async () => {
      const registry = createWorkspaceRegistry(fixture.db);
      registry.recordCreationIntent({
        id: 'ws-repo',
        type: 'local',
        kind: 'repository',
        location: 'local',
        path: 'C:\\Repo',
      });
      const record = hostRecord({
        id: 'ws-repo',
        kind: 'repository',
        path: 'c:\\REPO',
        parentId: null,
        gitAdminName: null,
      });
      // The first delivery fills the observation columns the creation intent left empty.
      await apply({ 'ws-repo': record }, stamp(1));
      expect(registry.getLive('ws-repo')?.path).toBe('C:\\Repo');

      const again = await apply({ 'ws-repo': record }, stamp(2));

      expect(again).toMatchObject({ refreshed: 0, unchanged: 1 });
      expect(registry.getLive('ws-repo')).toMatchObject({ path: 'C:\\Repo', observedAt: stamp(2) });
    });
  });

  /**
   * Live models key on projectId (`matchProject`): a poke without one refetches every
   * project. Each delivery pokes exactly the projects it changed, and a delivery that
   * only moved observation stamps pokes nobody.
   */
  describe('pokes', () => {
    function seedProject(projectId: string, repositoryWorkspaceId: string): void {
      fixture.sqlite
        .prepare(`INSERT INTO projects (id, name, repository_workspace_id) VALUES (?, ?, ?)`)
        .run(projectId, `project-${projectId}`, repositoryWorkspaceId);
    }

    function apply(records: WorkspaceRecords, observedAt: number) {
      return applyWorkspaceRegistrySnapshot({
        db: fixture.db,
        host: LOCAL_HOST,
        records,
        observedAt,
      });
    }

    async function pokesDuring(run: () => Promise<unknown>): Promise<WorkspacePoke[]> {
      const poke = vi.spyOn(appDbPokes.workspaces, 'poke');
      try {
        await run();
        return poke.mock.calls
          .map(([payload]) => payload)
          .sort((left, right) => (left.projectId ?? '').localeCompare(right.projectId ?? ''));
      } finally {
        poke.mockRestore();
      }
    }

    it('pokes each project the delivery changed and nobody for a stamp-only delivery', async () => {
      seedProject('project-a', 'repo-a');
      seedTask('project-b', 'task-b', 'wt-b');
      const records: WorkspaceRecords = {
        'repo-a': hostRecord({
          id: 'repo-a',
          kind: 'repository',
          path: '/repos/a',
          parentId: null,
          gitAdminName: null,
        }),
        // A repository's child lists under its project without any task link.
        'wt-a': hostRecord({ id: 'wt-a', parentId: 'repo-a' }),
        'wt-b': hostRecord({ id: 'wt-b' }),
        // Neither a project repository, its child, nor a task workspace: no view lists it.
        'wt-stray': hostRecord({ id: 'wt-stray', parentId: null }),
      };

      expect(await pokesDuring(() => apply(records, stamp(1)))).toEqual([
        { projectId: 'project-a' },
        { projectId: 'project-b' },
      ]);
      expect(await pokesDuring(() => apply(records, stamp(2)))).toEqual([]);

      const wtA = hostRecord({ id: 'wt-a', parentId: 'repo-a' });
      const changedChild: WorkspaceRecords = {
        ...records,
        'wt-a': { ...wtA, git: wtA.git === null ? null : { ...wtA.git, dirty: false } },
      };
      expect(await pokesDuring(() => apply(changedChild, stamp(3)))).toEqual([
        { projectId: 'project-a' },
      ]);

      const changedStray: WorkspaceRecords = {
        ...changedChild,
        'wt-stray': hostRecord({ id: 'wt-stray', parentId: null, lastActivatedAt: stamp(4) }),
      };
      expect(await pokesDuring(() => apply(changedStray, stamp(4)))).toEqual([]);

      // Losing the task's record marks it missing for that project; still missing is quiet.
      const { 'wt-b': _dropped, ...withoutTaskRow } = changedStray;
      expect(await pokesDuring(() => apply(withoutTaskRow, stamp(5)))).toEqual([
        { projectId: 'project-b' },
      ]);
      expect(await pokesDuring(() => apply(withoutTaskRow, stamp(6)))).toEqual([]);
    });
  });
});
