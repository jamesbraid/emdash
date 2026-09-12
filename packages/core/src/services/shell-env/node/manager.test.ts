import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const userInfoMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  statSync: vi.fn(() => ({ isDirectory: () => false })),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: () => '/home/test',
    userInfo: userInfoMock,
  },
}));

const { createShellEnvManager } = await import('./manager');

type FakeChild = EventEmitter & {
  pid: undefined;
  exitCode: null;
  signalCode: null;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

/** A probe child without a pid, so the process-tree terminator never signals a real process group. */
function createFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
}

function answerProbe(child: FakeChild, stdout: string): void {
  child.stdout.emit('data', stdout);
  child.emit('close', 0, null);
}

function timedOutProbe() {
  return {
    error: Object.assign(new Error('spawnSync /bin/bash ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null,
    signal: 'SIGTERM',
    stderr: '',
    stdout: '',
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  existsSyncMock.mockReset();
  userInfoMock.mockReset();
  userInfoMock.mockReturnValue({ shell: '/bin/bash' });
  existsSyncMock.mockReturnValue(true);
});

describe('createShellEnvManager', () => {
  it('starts and awaits the initial capture from current()', async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/shell/bin\nFOO=initial\n',
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
    });

    await expect(manager.current()).resolves.toMatchObject({
      FOO: 'initial',
      PATH: '/shell/bin:/worker/bin',
    });
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent refreshes', async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/usr/local/bin\nFOO=bar\n',
    });
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const manager = createShellEnvManager({
      target,
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/usr/bin' }),
    });

    await Promise.all([manager.refresh(), manager.refresh()]);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(target.FOO).toBe('bar');
    expect(target.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(manager.getUserShellEnv()).toMatchObject({
      FOO: 'bar',
      PATH: '/usr/local/bin:/usr/bin',
    });
  });

  it('keeps runtime controls in the host env but excludes them from the user snapshot', async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/shell/bin\nUSER_VALUE=kept\n',
    });
    const target: NodeJS.ProcessEnv = {
      PATH: '/worker/bin',
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    };
    const manager = createShellEnvManager({ target });

    await manager.refresh();

    expect(target.NODE_ENV).toBe('production');
    expect(target.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(manager.getUserShellEnv()).toEqual({
      PATH: '/shell/bin:/worker/bin',
      USER_VALUE: 'kept',
    });
  });

  it('preserves a runtime-named variable when the login shell explicitly exports it', async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/shell/bin\nNODE_ENV=development\n',
    });
    const target: NodeJS.ProcessEnv = { PATH: '/worker/bin', NODE_ENV: 'production' };
    const manager = createShellEnvManager({ target });

    await manager.refresh();

    expect(target.NODE_ENV).toBe('production');
    expect(manager.getUserShellEnv().NODE_ENV).toBe('development');
  });

  it('retains the last snapshot until an in-flight refresh publishes atomically', async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/tools/old\nUSER_VALUE=before-refresh\n',
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
    });
    await manager.refresh();

    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/tools/new\nUSER_VALUE=after-refresh\n',
    });
    const refresh = manager.refresh();

    expect(manager.getUserShellEnv()).toMatchObject({
      PATH: '/tools/old:/worker/bin',
      USER_VALUE: 'before-refresh',
    });
    await expect(manager.current()).resolves.toMatchObject({
      PATH: '/tools/new:/worker/bin',
      USER_VALUE: 'after-refresh',
    });
    await refresh;
  });

  it('logs and keeps the existing env when capture fails', async () => {
    const warn = vi.fn();
    spawnSyncMock.mockReturnValue({
      error: new Error('spawn failed'),
      status: null,
      stderr: '',
      stdout: '',
    });
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const manager = createShellEnvManager({
      target,
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/probe/bin' }),
      logger: { warn },
    });

    await expect(manager.refresh()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[shell-env] Failed to resolve login-shell env',
      expect.objectContaining({ shell: '/bin/bash', error: 'spawn failed' })
    );
    expect(target).toEqual({ PATH: '/usr/bin' });
    await expect(manager.current()).resolves.toEqual({
      PATH: '/probe/bin',
      SHELL: '/bin/bash',
    });
  });

  it('retains the last known-good snapshot when a later refresh fails', async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/tools/good\nUSER_VALUE=known-good\n',
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
    });
    await manager.refresh();

    spawnSyncMock.mockReturnValue({
      error: new Error('refresh failed'),
      status: null,
      stderr: '',
      stdout: '',
    });
    await manager.refresh();

    await expect(manager.current()).resolves.toMatchObject({
      PATH: '/tools/good:/worker/bin',
      USER_VALUE: 'known-good',
    });
    expect(manager.isDegraded()).toBe(false);
  });

  it('retries a timed-out probe once without blocking and applies the late capture', async () => {
    const warn = vi.fn();
    spawnSyncMock.mockReturnValueOnce(timedOutProbe());
    spawnMock.mockImplementationOnce(() => {
      const child = createFakeChild();
      queueMicrotask(() => answerProbe(child, 'PATH=/shell/bin\nSSH_AUTH_SOCK=/run/agent.sock\n'));
      return child;
    });
    const target: NodeJS.ProcessEnv = { PATH: '/worker/bin', SSH_AUTH_SOCK: '/launchd/Listeners' };
    const manager = createShellEnvManager({
      target,
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
      logger: { warn },
    });

    await manager.refresh();

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      ['-ilc', 'env'],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ DISABLE_AUTO_UPDATE: 'true' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    expect(target.SSH_AUTH_SOCK).toBe('/run/agent.sock');
    expect(target.PATH).toBe('/shell/bin:/worker/bin');
    expect(manager.getUserShellEnv().SSH_AUTH_SOCK).toBe('/run/agent.sock');
    expect(manager.isDegraded()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[shell-env] Login-shell probe timed out; retried',
      expect.objectContaining({
        shell: '/bin/bash',
        outcome: 'captured',
        firstAttemptMs: expect.any(Number),
        retryMs: expect.any(Number),
      })
    );
  });

  it('falls back to the bare env and marks the snapshot degraded after two timeouts', async () => {
    const warn = vi.fn();
    spawnSyncMock.mockReturnValueOnce(timedOutProbe());
    spawnMock.mockImplementationOnce(() => createFakeChild());
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const manager = createShellEnvManager({
      target,
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/probe/bin' }),
      retryTimeoutMs: 1,
      logger: { warn },
    });

    await manager.refresh();

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(manager.isDegraded()).toBe(true);
    expect(target).toEqual({ PATH: '/usr/bin' });
    await expect(manager.current()).resolves.toEqual({
      PATH: '/probe/bin',
      SHELL: '/bin/bash',
    });
    expect(warn).toHaveBeenCalledWith(
      '[shell-env] Login-shell probe timed out; retried',
      expect.objectContaining({ shell: '/bin/bash', outcome: 'failed', retryTimeoutMs: 1 })
    );
    expect(warn).toHaveBeenCalledWith(
      '[shell-env] Failed to resolve login-shell env',
      expect.objectContaining({ shell: '/bin/bash' })
    );
  });

  it('does not retry a shell that fails outright', async () => {
    spawnSyncMock.mockReturnValueOnce({
      error: undefined,
      status: 2,
      stderr: 'broken rc file',
      stdout: '',
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
      logger: { warn: vi.fn() },
    });

    await manager.refresh();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(manager.isDegraded()).toBe(true);
  });

  it('re-captures a degraded snapshot from ensureFresh() without blocking, coalescing callers', async () => {
    spawnSyncMock.mockReturnValueOnce(timedOutProbe());
    spawnMock.mockImplementationOnce(() => createFakeChild());
    const target: NodeJS.ProcessEnv = { PATH: '/worker/bin', SSH_AUTH_SOCK: '/launchd/Listeners' };
    const manager = createShellEnvManager({
      target,
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
      retryTimeoutMs: 1,
    });
    await manager.refresh();
    expect(manager.isDegraded()).toBe(true);

    spawnMock.mockImplementationOnce(() => {
      const child = createFakeChild();
      queueMicrotask(() => answerProbe(child, 'PATH=/shell/bin\nSSH_AUTH_SOCK=/run/agent.sock\n'));
      return child;
    });
    await Promise.all([manager.ensureFresh(), manager.ensureFresh()]);

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(manager.isDegraded()).toBe(false);
    expect(target.SSH_AUTH_SOCK).toBe('/run/agent.sock');
    expect(manager.getUserShellEnv().SSH_AUTH_SOCK).toBe('/run/agent.sock');
  });

  it('leaves a fresh snapshot alone from ensureFresh()', async () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: '',
      stdout: 'PATH=/shell/bin\n',
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
    });
    await manager.refresh();

    await manager.ensureFresh();

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(manager.isDegraded()).toBe(false);
  });
});
