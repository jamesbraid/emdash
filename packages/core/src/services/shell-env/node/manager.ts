import type { Result } from '@emdash/shared';
import { applyShellEnvCapture } from './apply';
import { captureShellEnv } from './capture';
import {
  type ShellEnvCapture,
  type ShellEnvCaptureError,
  type ShellEnvLogger,
  type ShellEnvManager,
  type ShellEnvPolicy,
} from './types';
import { buildUserShellEnvSeed } from './user-env';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_TIMEOUT_MS = 15_000;

export type CreateShellEnvManagerOptions = {
  readonly target?: NodeJS.ProcessEnv;
  readonly policy?: Partial<ShellEnvPolicy>;
  readonly baseEnvForProbe?: () => NodeJS.ProcessEnv;
  /** Budget for the first probe of a capture. */
  readonly timeoutMs?: number;
  /** Budget for the one non-blocking retry after that probe times out; 0 disables it. */
  readonly retryTimeoutMs?: number;
  readonly logger?: ShellEnvLogger;
};

export function createShellEnvManager(options: CreateShellEnvManagerOptions = {}): ShellEnvManager {
  const target = options.target ?? process.env;
  const userEnv = stringEnv(buildUserShellEnvSeed(options.baseEnvForProbe?.() ?? target));
  let inFlight: Promise<void> | undefined;
  let captureStarted = false;
  let hasGoodSnapshot = false;
  let degraded = false;

  const run = (blocking: boolean): Promise<void> => {
    captureStarted = true;
    inFlight ??= refreshShellEnv(target, userEnv, hasGoodSnapshot, blocking, options)
      .then((succeeded) => {
        if (succeeded) hasGoodSnapshot = true;
        degraded = !hasGoodSnapshot;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    env: target,
    async current() {
      if (!captureStarted) await run(true);
      else await inFlight;
      return { ...userEnv };
    },
    getUserShellEnv: () => ({ ...userEnv }),
    refresh: () => run(true),
    isDegraded: () => degraded,
    async ensureFresh() {
      await inFlight;
      if (!hasGoodSnapshot) await run(false);
    },
  };
}

async function refreshShellEnv(
  target: NodeJS.ProcessEnv,
  userEnv: Record<string, string>,
  hasGoodSnapshot: boolean,
  blocking: boolean,
  options: CreateShellEnvManagerOptions
): Promise<boolean> {
  const baseEnv = buildUserShellEnvSeed(options.baseEnvForProbe?.() ?? target);
  const capture = await captureWithRetry(baseEnv, blocking, options);

  if (!capture.success) {
    options.logger?.warn?.('[shell-env] Failed to resolve login-shell env', {
      shell: capture.error.shell,
      error: capture.error.message,
    });
    if (!hasGoodSnapshot) replaceEnv(userEnv, stringEnv(baseEnv));
    return false;
  }

  applyShellEnvCapture(target, capture.data, options.policy, { mergeBaseEnv: baseEnv });
  const nextUserEnv = stringEnv(baseEnv);
  applyShellEnvCapture(
    nextUserEnv,
    capture.data,
    { ...options.policy, preserveKeys: new Set() },
    { mergeBaseEnv: baseEnv }
  );
  replaceEnv(userEnv, nextUserEnv);

  options.logger?.info?.('[shell-env] Resolved shell env', {
    source: capture.data.source,
    pathEntries: target.PATH?.split(process.platform === 'win32' ? ';' : ':').length ?? 0,
  });
  return true;
}

/**
 * A login shell that is merely slow to start (heavy load, a network-backed rc file) gets
 * one longer attempt off the event loop before the bare process env is accepted. A shell
 * that fails outright is not retried.
 */
async function captureWithRetry(
  baseEnv: NodeJS.ProcessEnv,
  blocking: boolean,
  options: CreateShellEnvManagerOptions
): Promise<Result<ShellEnvCapture, ShellEnvCaptureError>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryTimeoutMs = options.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  const startedAt = Date.now();
  const first = await captureShellEnv({ baseEnv, timeoutMs, blocking });
  if (first.success || !first.error.timedOut || retryTimeoutMs <= 0) return first;

  const firstAttemptMs = Date.now() - startedAt;
  const retry = await captureShellEnv({ baseEnv, timeoutMs: retryTimeoutMs, blocking: false });
  options.logger?.warn?.('[shell-env] Login-shell probe timed out; retried', {
    shell: first.error.shell,
    timeoutMs,
    retryTimeoutMs,
    firstAttemptMs,
    retryMs: Date.now() - startedAt - firstAttemptMs,
    outcome: retry.success ? 'captured' : 'failed',
  });
  return retry;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function replaceEnv(target: Record<string, string>, source: Record<string, string>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}
