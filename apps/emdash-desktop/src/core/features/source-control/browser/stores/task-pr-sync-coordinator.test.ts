import { ok } from '@emdash/shared';
import { cell, expose } from '@emdash/wire/state';
import { createTestWire } from '@emdash/wire/testing';
import { observable, runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitRepositoryStore } from '@core/features/source-control/api/browser/stores/git-repository-store';
import { getTaskPrAssociationStore } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import type { TaskManagerStore } from '@core/features/tasks/api/browser/stores/task-manager';
import {
  createUnprovisionedTask,
  type TaskStore,
} from '@core/features/tasks/api/browser/stores/task-store';
import type { Task, WorkspaceObservedPrFacts } from '@core/primitives/tasks/api';
import { pullRequestsContract, type SyncState } from '@core/services/pull-requests/api';
import type { PullRequestsRuntimeClient } from '@core/services/pull-requests/api/client';
import { TaskPrSyncCoordinator } from './task-pr-sync-coordinator';

const mocks = vi.hoisted(() => ({
  getPullRequestsRuntimeClient: vi.fn<() => Promise<PullRequestsRuntimeClient>>(
    () => new Promise<never>(() => {})
  ),
}));

vi.mock('@core/manifests/browser/task-persistent-stores', async () => {
  const { sourceControlPersistentTaskStoreContributions } =
    await import('@core/features/source-control/contributions/browser/task-stores');
  return {
    taskPersistentStoreContributions: sourceControlPersistentTaskStoreContributions.filter(
      (contribution) => contribution.token.id === 'source-control.task-pr-association'
    ),
  };
});

vi.mock('@core/manifests/browser/task-scoped-stores', () => ({
  taskStoreContributions: [],
}));

vi.mock('@core/services/pull-requests/api/client', () => ({
  getPullRequestsRuntimeClient: mocks.getPullRequestsRuntimeClient,
}));

const coordinators: TaskPrSyncCoordinator[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const coordinator of coordinators) coordinator.dispose();
  coordinators.length = 0;
  for (const cleanup of cleanups.splice(0)) await cleanup();
  mocks.getPullRequestsRuntimeClient.mockReset();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    name: 'Task 1',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    prs: [
      {
        url: 'https://github.com/emdash/emdash/pull/42',
        repositoryUrl: 'https://github.com/emdash/emdash',
      } as Task['prs'][number],
    ],
    conversations: {},
    workspaceId: 'workspace-1',
    type: 'task',
    ...overrides,
  };
}

function makeTasks(...taskList: Task[]): TaskManagerStore {
  const stores = taskList.map((task) => {
    const store = createUnprovisionedTask(task);
    getTaskPrAssociationStore(store).setAssociation(task.prs, { kind: 'unknown' });
    return [task.id, store] as const;
  });
  return { tasks: observable.map(stores) } as unknown as TaskManagerStore;
}

function taskStore(tasks: TaskManagerStore, taskId: string): TaskStore {
  const store = tasks.tasks.get(taskId);
  if (!store) throw new Error(`Missing task ${taskId}`);
  return store;
}

function prs(tasks: TaskManagerStore, taskId: string): readonly Task['prs'][number][] | undefined {
  const store = tasks.tasks.get(taskId);
  return store ? getTaskPrAssociationStore(store).pullRequests : undefined;
}

function makeRepository(input: {
  repositoryUrl: string | null;
  observation:
    | { kind: 'unavailable' }
    | {
        kind: 'fresh';
        value:
          | { success: false; error: { type: 'no_remote' } }
          | {
              success: true;
              data: {
                provider: 'github';
                host: string;
                repositoryUrl: string;
                nameWithOwner: string;
                capabilities: { pullRequests: boolean; issues: boolean };
              };
            };
        observedAt: number;
      };
}): GitRepositoryStore {
  return observable({
    pullRequestRepositoryUrl: input.repositoryUrl,
    providerRepositoryObservation: input.observation,
  }) as unknown as GitRepositoryStore;
}

function start(tasks: TaskManagerStore, repository: GitRepositoryStore): TaskPrSyncCoordinator {
  const coordinator = new TaskPrSyncCoordinator(tasks, repository);
  coordinators.push(coordinator);
  return coordinator;
}

describe('TaskPrSyncCoordinator association preservation', () => {
  it('preserves the last-known PR when the base remote is removed', () => {
    const task = makeTask();
    const tasks = makeTasks(task);
    const repository = makeRepository({
      repositoryUrl: null,
      observation: {
        kind: 'fresh',
        value: { success: false, error: { type: 'no_remote' } },
        observedAt: 1,
      },
    });

    start(tasks, repository);

    expect(prs(tasks, task.id)).toHaveLength(1);
  });

  it('preserves a stale PR while repository capability is transiently unavailable', () => {
    const task = makeTask();
    const tasks = makeTasks(task);
    const repository = makeRepository({
      repositoryUrl: null,
      observation: { kind: 'unavailable' },
    });

    start(tasks, repository);

    expect(prs(tasks, task.id)).toHaveLength(1);
  });

  it('preserves the last-known PR when a task no longer has a durable workspace', () => {
    const task = makeTask({ workspaceId: undefined });
    const tasks = makeTasks(task);
    const repositoryUrl = 'https://github.com/emdash/emdash';
    const repository = makeRepository({
      repositoryUrl,
      observation: {
        kind: 'fresh',
        value: {
          success: true,
          data: {
            provider: 'github',
            host: 'github.com',
            repositoryUrl,
            nameWithOwner: 'emdash/emdash',
            capabilities: { pullRequests: true, issues: true },
          },
        },
        observedAt: 1,
      },
    });

    start(tasks, repository);

    expect(prs(tasks, task.id)).toHaveLength(1);
  });

  it('preserves a stale PR during a transient input-less read of an associated workspace', () => {
    const task = makeTask();
    const tasks = makeTasks(task);
    const repositoryUrl = 'https://github.com/emdash/emdash';
    const repository = makeRepository({
      repositoryUrl,
      observation: {
        kind: 'fresh',
        value: {
          success: true,
          data: {
            provider: 'github',
            host: 'github.com',
            repositoryUrl,
            nameWithOwner: 'emdash/emdash',
            capabilities: { pullRequests: true, issues: true },
          },
        },
        observedAt: 1,
      },
    });

    start(tasks, repository);

    expect(prs(tasks, task.id)).toHaveLength(1);
  });

  it('preserves the last-known PR when the associated workspace checkout is missing', () => {
    const task = makeTask();
    const tasks = makeTasks(task);
    runInAction(() => {
      const store = tasks.tasks.get(task.id);
      if (store) {
        store.workspaceObservedStatus = 'missing';
        store.workspaceObservedPr = {
          branch: 'feature',
          prBreadcrumb: 'https://github.com/emdash/emdash/pull/42',
          upstream: null,
          headOid: null,
          ahead: null,
          behind: null,
        };
      }
    });
    const repositoryUrl = 'https://github.com/emdash/emdash';
    const repository = makeRepository({
      repositoryUrl,
      observation: {
        kind: 'fresh',
        value: {
          success: true,
          data: {
            provider: 'github',
            host: 'github.com',
            repositoryUrl,
            nameWithOwner: 'emdash/emdash',
            capabilities: { pullRequests: true, issues: true },
          },
        },
        observedAt: 1,
      },
    });

    start(tasks, repository);

    expect(prs(tasks, task.id)).toHaveLength(1);
  });

  it('preserves the last-known PR while a changed repository is being resolved', () => {
    const task = makeTask({
      prs: [
        {
          url: 'https://github.com/emdash/old-repository/pull/42',
          repositoryUrl: 'https://github.com/emdash/old-repository',
        } as Task['prs'][number],
      ],
    });
    const tasks = makeTasks(task);
    const repositoryUrl = 'https://github.com/emdash/new-repository';
    const repository = makeRepository({
      repositoryUrl,
      observation: {
        kind: 'fresh',
        value: {
          success: true,
          data: {
            provider: 'github',
            host: 'github.com',
            repositoryUrl,
            nameWithOwner: 'emdash/new-repository',
            capabilities: { pullRequests: true, issues: true },
          },
        },
        observedAt: 1,
      },
    });

    start(tasks, repository);

    expect(prs(tasks, task.id)).toHaveLength(1);
  });

  it('preserves the last-known PR when an available remote is removed', () => {
    const task = makeTask();
    const tasks = makeTasks(task);
    const repositoryUrl = 'https://github.com/emdash/emdash';
    const repository = makeRepository({
      repositoryUrl,
      observation: {
        kind: 'fresh',
        value: {
          success: true,
          data: {
            provider: 'github',
            host: 'github.com',
            repositoryUrl,
            nameWithOwner: 'emdash/emdash',
            capabilities: { pullRequests: true, issues: true },
          },
        },
        observedAt: 1,
      },
    });
    start(tasks, repository);

    runInAction(() => {
      const mutableRepository = repository as unknown as {
        pullRequestRepositoryUrl: string | null;
        providerRepositoryObservation: {
          kind: 'fresh';
          value: { success: false; error: { type: 'no_remote' } };
          observedAt: number;
        };
      };
      mutableRepository.pullRequestRepositoryUrl = null;
      mutableRepository.providerRepositoryObservation = {
        kind: 'fresh',
        value: { success: false, error: { type: 'no_remote' } },
        observedAt: 2,
      };
    });

    expect(prs(tasks, task.id)).toHaveLength(1);
  });
});

const repositoryUrl = 'https://github.com/emdash/emdash';

function makeAvailableRepository(): GitRepositoryStore {
  return makeRepository({
    repositoryUrl,
    observation: {
      kind: 'fresh',
      value: {
        success: true,
        data: {
          provider: 'github',
          host: 'github.com',
          repositoryUrl,
          nameWithOwner: 'emdash/emdash',
          capabilities: { pullRequests: true, issues: true },
        },
      },
      observedAt: 1,
    },
  });
}

/** An in-process PR runtime whose cache lookups are spies and whose sync state never moves. */
function makePullRequestsWire() {
  const getPullRequestsForHead = vi.fn(
    async (_input: Parameters<PullRequestsRuntimeClient['getPullRequestsForHead']>[0]) =>
      ok({ prs: [] })
  );
  const getPullRequestByUrl = vi.fn(
    async (_input: Parameters<PullRequestsRuntimeClient['getPullRequestByUrl']>[0]) =>
      ok({ pr: null })
  );
  const syncState = expose(pullRequestsContract.syncState, {
    state: () => cell<SyncState>({ phase: 'idle', kind: null }),
  });
  const wire = createTestWire(pullRequestsContract, {
    getPullRequestsForHead,
    getPullRequestByUrl,
    syncState,
  });
  cleanups.push(
    () => wire.dispose(),
    () => syncState.dispose()
  );
  mocks.getPullRequestsRuntimeClient.mockResolvedValue(wire.client);
  return { getPullRequestsForHead, getPullRequestByUrl };
}

function observedFacts(
  branch: string,
  overrides: Partial<WorkspaceObservedPrFacts> = {}
): WorkspaceObservedPrFacts {
  return {
    branch,
    prBreadcrumb: null,
    upstream: { mergeRef: `refs/heads/${branch}`, remoteUrl: repositoryUrl },
    headOid: '1'.repeat(40),
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

/** A registry delivery: the store receives a freshly built facts object every time. */
function project(store: TaskStore, observedPr: WorkspaceObservedPrFacts): void {
  store.setWorkspaceProjection({ path: null, observedStatus: 'present', observedPr });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('TaskPrSyncCoordinator reload scoping', () => {
  async function startTwoTasks() {
    const client = makePullRequestsWire();
    const tasks = makeTasks(makeTask(), makeTask({ id: 'task-2', workspaceId: 'workspace-2' }));
    project(taskStore(tasks, 'task-1'), observedFacts('feature-1'));
    project(taskStore(tasks, 'task-2'), observedFacts('feature-2'));
    start(tasks, makeAvailableRepository());
    await vi.waitFor(() => expect(client.getPullRequestsForHead).toHaveBeenCalledTimes(2));
    client.getPullRequestsForHead.mockClear();
    return { ...client, tasks };
  }

  it('skips cache lookups when identical observed facts are re-projected', async () => {
    const { tasks, getPullRequestsForHead, getPullRequestByUrl } = await startTwoTasks();

    for (let i = 0; i < 5; i++) {
      project(taskStore(tasks, 'task-1'), observedFacts('feature-1'));
      project(taskStore(tasks, 'task-2'), observedFacts('feature-2'));
    }
    await settle();

    expect(getPullRequestsForHead).not.toHaveBeenCalled();
    expect(getPullRequestByUrl).not.toHaveBeenCalled();
  });

  it('reloads only the task whose observed head moved', async () => {
    const { tasks, getPullRequestsForHead } = await startTwoTasks();

    project(taskStore(tasks, 'task-2'), observedFacts('feature-2', { headOid: '2'.repeat(40) }));
    await vi.waitFor(() => expect(getPullRequestsForHead).toHaveBeenCalledTimes(1));
    await settle();

    expect(getPullRequestsForHead).toHaveBeenCalledTimes(1);
    expect(getPullRequestsForHead.mock.calls[0]?.[0]).toMatchObject({ headRefName: 'feature-2' });
  });
});
