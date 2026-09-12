import { createEmitter, type PendingLease, type Unsubscribe } from '@emdash/shared';
import { stableStringify } from '@emdash/shared/util';
import type { LiveLogSnapshotData, LiveSnapshot, LiveSource, LiveUpdate } from '../../api/channel';
import type { LiveLogClientHandle } from '../../api/client';
import type { LiveLogEndpointDef, LiveLogKey } from '../../api/define';
import type { WireInstrumentation } from '../../api/instrumentation';
import { resyncRetry, type LiveResyncFailurePolicy } from '../follower';
import { LiveLogSource, LiveLogClient, type LiveLogSourceOptions } from '../log';
import { createReplicaResourceCache } from './retention';
import { resourceCachedLiveSource } from './source';

export interface LogSink {
  reset(data: LiveLogSnapshotData): void;
  append(chunk: string): void;
}

export interface LogStore extends LogSink {
  text(): string;
}

export type ReplicaLogOptions = LiveLogSourceOptions & {
  instrumentation?: WireInstrumentation;
  /** Resync failure policy; production replicas retry until success or dispose. */
  onResyncFailed?: LiveResyncFailurePolicy;
  store?: LogSink;
};

export class ReplicaLog implements LiveSource {
  readonly ready: Promise<void>;

  private local: LiveLogSource | undefined;
  private readonly client: LiveLogClient;
  private readonly appendEmitter = createEmitter<string>();
  /** The transport subscription; null while parked and after dispose. */
  private attachment: Promise<Unsubscribe> | null = null;
  /** Detaches still in flight, so dispose resolves only once they land. */
  private releasing: Promise<void> = Promise.resolve();
  private writtenOffset = 0;
  private disposed = false;

  constructor(
    private readonly handle: ReturnType<LiveLogClientHandle['handle']>,
    private readonly options: ReplicaLogOptions = {}
  ) {
    if (!options.store) this.local = new LiveLogSource(options);
    this.client = new LiveLogClient({
      refetchSnapshot: () => handle.snapshot(),
      onReset: (data) => this.reset(data),
      onAppend: (chunk) => this.append(chunk),
      onResyncFailed: options.onResyncFailed ?? resyncRetry(),
      instrumentation: options.instrumentation,
      topic: handle.topic,
    });
    this.ready = handle.snapshot().then((snapshot) => this.client.seed(snapshot));
    this.attachment = this.attach();
  }

  text(): string {
    const readable = asReadableLogStore(this.options.store);
    if (readable) return readable.text();
    if (this.local) return this.local.snapshot().data.text;
    throw new Error('ReplicaLog is backed by a write-only LogSink');
  }

  onAppend(cb: (chunk: string) => void): Unsubscribe {
    return this.appendEmitter.subscribe(cb);
  }

  async snapshot(): Promise<LiveSnapshot<LiveLogSnapshotData>> {
    await this.ready;
    return this.localSource().snapshot();
  }

  subscribe(cb: (update: LiveUpdate) => void): Unsubscribe {
    return this.localSource().subscribe(cb);
  }

  /**
   * Releases the transport subscription while keeping the materialized log and
   * its offsets, so `resume()` can pick up where the stream left off instead of
   * replaying the retained tail. Idempotent; resolves once the transport has
   * detached, and is a no-op after dispose.
   */
  park(): Promise<void> {
    const attachment = this.attachment;
    if (attachment) {
      this.attachment = null;
      // A subscription that never established has nothing to release.
      const release = attachment.then(
        (detach) => detach(),
        () => {}
      );
      this.releasing = this.releasing.then(() => release);
    }
    return this.releasing;
  }

  /**
   * Re-attaches after `park()` and refetches the snapshot: the materializer
   * appends only the bytes missed while parked when the source still retains
   * them, and resets to the retained tail otherwise. Idempotent; a park or
   * dispose racing the attach wins.
   */
  async resume(): Promise<void> {
    if (this.disposed || this.attachment) return;
    const attachment = this.attach();
    this.attachment = attachment;
    try {
      await attachment;
    } catch (error) {
      if (this.attachment === attachment) this.attachment = null;
      throw error;
    }
    if (this.attachment !== attachment) return;
    this.client.invalidate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.client.dispose();
    this.appendEmitter.clear();
    await this.park();
  }

  private attach(): Promise<Unsubscribe> {
    return this.handle.attach((update) => this.client.applyUpdate(update), {
      onReattach: () => this.client.invalidate(),
    });
  }

  private reset(data: LiveLogSnapshotData): void {
    this.options.store?.reset(data);
    this.local?.reseed(data);
    this.writtenOffset = data.baseOffset + byteLength(data.text);
  }

  private append(chunk: string): void {
    this.options.store?.append(chunk);
    this.local?.append(chunk);
    this.writtenOffset += byteLength(chunk);
    this.appendEmitter.emit(chunk);
  }

  private localSource(): LiveLogSource {
    if (!this.local) {
      const readable = asReadableLogStore(this.options.store);
      const text = readable?.text() ?? '';
      const bytes = byteLength(text);
      const baseOffset = this.writtenOffset >= bytes ? this.writtenOffset - bytes : 0;
      this.local = new LiveLogSource(this.options);
      this.local.reseed({
        baseOffset,
        text,
        truncated: true,
      });
    }
    return this.local;
  }
}

export type LiveLogReplicaCacheOptions = Omit<ReplicaLogOptions, 'store'> & {
  lingerMs?: number;
  store?: () => LogSink;
};

export type LiveLogReplicaCache<Def extends LiveLogEndpointDef = LiveLogEndpointDef> = {
  readonly kind: 'liveLogReplicaCache';
  readonly def: Def;
  acquire(key: LiveLogKey<Def>): PendingLease<ReplicaLog>;
  peek(key: LiveLogKey<Def>): ReplicaLog | undefined;
  resolve(key: LiveLogKey<Def>): LiveSource;
  dispose(): Promise<void>;
};

export function createLiveLogReplicaCache<Def extends LiveLogEndpointDef>(
  def: Def,
  log: LiveLogClientHandle<Def>,
  options: LiveLogReplicaCacheOptions = {}
): LiveLogReplicaCache<Def> {
  const source = createReplicaResourceCache<LiveLogKey<Def>, ReplicaLog>({
    key: stableStringify,
    lingerMs: options.lingerMs,
    async create(key, scope) {
      const { store, ...replicaOptions } = options;
      const replica = new ReplicaLog(log.handle(key), { ...replicaOptions, store: store?.() });
      scope.add(() => replica.dispose());
      await replica.ready;
      return replica;
    },
  });

  return {
    kind: 'liveLogReplicaCache',
    def,
    acquire(key) {
      return source.acquire(key);
    },
    peek(key) {
      return source.peek(key);
    },
    resolve(key) {
      return resourceCachedLiveSource(source, key, (replica) => replica);
    },
    dispose() {
      return source.dispose();
    },
  };
}

function asReadableLogStore(store: LogSink | undefined): LogStore | undefined {
  if (!store) return undefined;
  const candidate = store as Partial<LogStore>;
  return typeof candidate.text === 'function' ? (store as LogStore) : undefined;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function isLiveLogReplicaCache(value: unknown): value is LiveLogReplicaCache {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'liveLogReplicaCache'
  );
}
