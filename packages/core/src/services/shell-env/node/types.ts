export type ShellEnvPlatform = 'posix' | 'windows';

export type ShellEnvSource = 'login-shell' | 'windows' | 'process-fallback';

export type ShellEnvCapture = {
  readonly env: Record<string, string>;
  readonly source: ShellEnvSource;
  readonly capturedAt: number;
};

export type ShellEnvCaptureError = {
  readonly type: 'capture-failed';
  readonly shell?: string;
  readonly message: string;
  /** The shell was still running when its budget ran out, so a retry may succeed. */
  readonly timedOut: boolean;
};

export type ShellEnvPolicy = {
  readonly preserveKeys: ReadonlySet<string>;
  readonly userBinDirs: readonly string[];
  readonly platform?: ShellEnvPlatform;
};

export type ShellEnvLogger = {
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
};

export type ShellEnvManager = {
  /** The operational host process environment updated for compatibility consumers. */
  readonly env: NodeJS.ProcessEnv;
  /** Awaits any initial or in-flight capture and returns an owned user-shell snapshot. */
  current(): Promise<Record<string, string>>;
  /** Returns an owned user-shell snapshot with host runtime controls excluded. */
  getUserShellEnv(): Record<string, string>;
  refresh(): Promise<void>;
  /** True while the snapshot is the bare process env because every capture so far failed. */
  isDegraded(): boolean;
  /**
   * Captures again, without blocking the event loop, while no capture has succeeded;
   * otherwise resolves immediately. Concurrent callers share one capture.
   */
  ensureFresh(): Promise<void>;
};

export const SHELL_ENV_CAPTURE_GUARD: Record<string, string> = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
  ZSH_TMUX_AUTOSTARTED: 'true',
};

export const DEFAULT_SHELL_ENV_PRESERVE_KEYS = new Set(['NODE_ENV']);
