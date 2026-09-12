export type ParkedOutputOptions = {
  /** How long an off-screen terminal keeps streaming before its output is parked. */
  lingerMs: number;
  /** Releases the live output transport; the replica and its offset stay put. */
  park: () => void;
  /** Re-attaches the transport and lets the replica catch up from its offset. */
  resume: () => void;
};

export type ParkedOutput = {
  /** The output subscription is live; an unmounted terminal starts its linger now. */
  connected(): void;
  mount(): void;
  unmount(): void;
  dispose(): void;
  readonly parked: boolean;
};

/**
 * Decides when a terminal's live output should be parked and resumed.
 *
 * A parked (off-screen) terminal keeps receiving and parsing every output
 * chunk although nothing renders it, and with dozens of open sessions that
 * is most of the renderer's work and, for remote hosts, of the SSH link.
 * Unmounting starts a linger so tab flips stay instant; once it expires the
 * transport is parked, and the next mount resumes it. The replica survives
 * the park, so resuming appends only what was missed while hidden.
 */
export function createParkedOutput(options: ParkedOutputOptions): ParkedOutput {
  let connected = false;
  let mounted = false;
  let parked = false;
  let disposed = false;
  let linger: ReturnType<typeof setTimeout> | undefined;

  const clearLinger = (): void => {
    if (linger === undefined) return;
    clearTimeout(linger);
    linger = undefined;
  };

  const startLinger = (): void => {
    clearLinger();
    linger = setTimeout(() => {
      linger = undefined;
      if (mounted || parked || disposed) return;
      parked = true;
      options.park();
    }, options.lingerMs);
  };

  return {
    connected() {
      if (disposed) return;
      connected = true;
      parked = false;
      if (!mounted) startLinger();
    },
    mount() {
      mounted = true;
      clearLinger();
      if (disposed || !parked) return;
      parked = false;
      options.resume();
    },
    unmount() {
      mounted = false;
      if (disposed || !connected || parked) return;
      startLinger();
    },
    dispose() {
      disposed = true;
      clearLinger();
    },
    get parked() {
      return parked;
    },
  };
}
