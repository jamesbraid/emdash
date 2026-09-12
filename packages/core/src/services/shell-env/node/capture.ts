import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { err, ok, type Result } from '@emdash/shared';
import { recordSpawn } from '@emdash/shared/perf';
import { createChildProcessTreeTerminator } from '#primitives/exec/node';
import { SHELL_ENV_CAPTURE_GUARD, type ShellEnvCapture, type ShellEnvCaptureError } from './types';

export type CaptureShellEnvOptions = {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /**
   * Whether the probe may hold the event loop until the shell exits (the default). Boot
   * relies on that so `process.env` is settled before later phases run; retries and
   * re-captures pass `false` so a slow shell cannot freeze the app.
   */
  readonly blocking?: boolean;
};

const PROBE_ARGS = ['-ilc', 'env'];
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 1024 * 1024;

type ProbeResult = {
  readonly error?: Error;
  readonly timedOut: boolean;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

export function parseEnvOutput(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key && /^[A-Za-z_]\w*$/.test(key)) {
      result[key] = value;
    }
  }
  return result;
}

export async function captureShellEnv(
  options: CaptureShellEnvOptions = {}
): Promise<Result<ShellEnvCapture, ShellEnvCaptureError>> {
  const baseEnv = options.baseEnv ?? process.env;
  const now = options.now ?? Date.now;

  if (process.platform === 'win32') {
    return ok({
      env: withoutCaptureGuard(stringEnv(baseEnv)),
      source: 'windows',
      capturedAt: now(),
    });
  }

  const shell = resolveLoginShell(baseEnv);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = { ...baseEnv, ...SHELL_ENV_CAPTURE_GUARD };
  recordSpawn('shell', shell);
  const result =
    options.blocking === false
      ? await probeWithoutBlocking(shell, env, timeoutMs)
      : probeBlocking(shell, env, timeoutMs);

  if (result.error) {
    return err({
      type: 'capture-failed',
      shell,
      message: result.error.message,
      timedOut: result.timedOut,
    });
  }

  if (result.status !== 0) {
    return err({
      type: 'capture-failed',
      shell,
      message:
        result.stderr.trim() ||
        (result.signal
          ? `shell env capture was killed by ${result.signal}`
          : `shell env capture exited with status ${result.status}`),
      timedOut: false,
    });
  }

  return ok({
    env: withoutCaptureGuard(parseEnvOutput(result.stdout)),
    source: 'login-shell',
    capturedAt: now(),
  });
}

function probeBlocking(shell: string, env: NodeJS.ProcessEnv, timeoutMs: number): ProbeResult {
  // Built as a separate object: node honours `detached` for spawnSync, but the typings omit
  // it, so an inline literal fails the excess-property check.
  const options = {
    encoding: 'utf8' as const,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  };
  const result = spawnSync(shell, PROBE_ARGS, options);
  return {
    error: result.error,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function probeWithoutBlocking(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(shell, PROBE_ARGS, {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminator = createChildProcessTreeTerminator(child, { processGroup: true });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let abort: Pick<ProbeResult, 'error' | 'timedOut'> | undefined;

    const settle = (status: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        error: abort?.error ?? error,
        timedOut: abort?.timedOut ?? false,
        status,
        signal,
        stdout,
        stderr,
      });
    };
    const kill = (error: Error, timedOut: boolean) => {
      if (settled || abort) return;
      abort = { error, timedOut };
      // `close` normally follows; settling once the process group is gone also covers a
      // shell stuck in the kernel that never closes its pipes.
      void terminator.terminate().then(() => settle(null, null));
    };
    const timer = setTimeout(
      () => kill(new Error(`${shell} did not answer within ${timeoutMs}ms`), true),
      timeoutMs
    );
    const collect = (append: (chunk: string) => void) => (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BUFFER)
        kill(new Error(`${shell} printed more than ${MAX_BUFFER} bytes`), false);
      else append(chunk);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on(
      'data',
      collect((chunk) => {
        stdout += chunk;
      })
    );
    child.stderr.setEncoding('utf8');
    child.stderr.on(
      'data',
      collect((chunk) => {
        stderr += chunk;
      })
    );
    child.once('error', (error) => settle(null, null, error));
    child.once('close', (status, signal) => settle(status, signal));
  });
}

function withoutCaptureGuard(env: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(SHELL_ENV_CAPTURE_GUARD)) {
    delete env[key];
  }
  return env;
}

export function resolveLoginShell(env: NodeJS.ProcessEnv = process.env): string {
  return candidateShells(env).find((candidate) => existsSync(candidate)) ?? '/bin/sh';
}

function candidateShells(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.SHELL, userShell(), '/bin/bash', '/bin/sh'].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0
  );
  return [...new Set(candidates)];
}

function userShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}
