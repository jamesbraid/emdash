import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureShellEnv } from './capture';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in login shell. The probe passes `-ilc env`; the script ignores its arguments. */
async function fakeShell(body: string): Promise<{ dir: string; shell: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'emdash-shell-env-probe-'));
  tempDirs.push(dir);
  const shell = path.join(dir, 'login-shell');
  await writeFile(shell, `#!/bin/sh\n${body}\n`);
  await chmod(shell, 0o755);
  return { dir, shell };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === 'win32')('captureShellEnv without blocking', () => {
  it('keeps the event loop running while the shell starts', async () => {
    const { shell } = await fakeShell("sleep 0.2\nprintf 'PATH=/probe/bin\\nFOO=bar\\n'");
    // A timer can only fire while the capture is pending if the probe yields the event loop;
    // the blocking probe holds it until the shell exits.
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 20);

    const result = await captureShellEnv({
      baseEnv: { SHELL: shell, PATH: '/usr/bin' },
      blocking: false,
      now: () => 7,
    });

    clearTimeout(timer);
    expect(ticked).toBe(true);
    expect(result).toEqual({
      success: true,
      data: { env: { PATH: '/probe/bin', FOO: 'bar' }, source: 'login-shell', capturedAt: 7 },
    });
  });

  it('kills a shell that ignores SIGTERM once the budget runs out', async () => {
    const { dir, shell } = await fakeShell('');
    const pidPath = path.join(dir, 'shell.pid');
    // The pid lands first so the assertion below holds even if a slow shell start means the
    // budget expires before the trap is installed.
    await writeFile(shell, `#!/bin/sh\necho $$ > "${pidPath}"\ntrap '' TERM\nsleep 30\n`);

    const result = await captureShellEnv({
      baseEnv: { SHELL: shell },
      blocking: false,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'capture-failed',
        shell,
        message: expect.stringContaining('1000ms'),
        timedOut: true,
      },
    });
    const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
    await expect.poll(() => isAlive(pid), { timeout: 3_000, interval: 50 }).toBe(false);
  });
});
