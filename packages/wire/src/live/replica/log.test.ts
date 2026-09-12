import { waitFor } from '@emdash/shared/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LiveLogSnapshotData } from '../../api/channel';
import { defineContract, liveLog } from '../../api/define';
import { createTestWire } from '../../testing';
import { LiveLogSource } from '../log';
import { createLiveLogReplicaCache, ReplicaLog, type LogSink } from './log';

const api = defineContract({
  output: liveLog({ key: z.object({ id: z.string() }) }),
});

describe('createLiveLogReplicaCache', () => {
  it('seeds retained text and passes through appends under local cursors', async () => {
    const key = { id: 'session' };
    const log = new LiveLogSource({ generation: 1000 });
    log.append('seed\n');
    const contractClient = createTestWire(api, { output: () => log }).client;

    const replica = createLiveLogReplicaCache(api.output, contractClient.output);
    const lease = replica.acquire(key);
    const output = await lease.ready();
    const appends: string[] = [];
    output.onAppend((chunk) => appends.push(chunk));

    expect(output.text()).toBe('seed\n');
    log.append('next\n');
    await waitFor(() => appends.length === 1);

    expect(appends).toEqual(['next\n']);
    expect((await output.snapshot()).data.text).toBe('seed\nnext\n');

    await lease.release();
    await replica.dispose();
  });

  it('writes through to a custom log store', async () => {
    const key = { id: 'session' };
    const log = new LiveLogSource({ generation: 1000 });
    log.append('seed');
    const contractClient = createTestWire(api, { output: () => log }).client;
    let text = '';

    const replica = createLiveLogReplicaCache(api.output, contractClient.output, {
      store: () => ({
        reset: (data) => {
          text = data.text;
        },
        append: (chunk) => {
          text += chunk;
        },
        text: () => text,
      }),
    });
    const lease = replica.acquire(key);
    const output = await lease.ready();

    expect(output.text()).toBe('seed');
    log.append('\nnext');
    await waitFor(() => output.text() === 'seed\nnext');

    await lease.release();
    await replica.dispose();
  });

  it('supports write-only log sinks without readable text', async () => {
    const key = { id: 'session' };
    const log = new LiveLogSource({ generation: 1000 });
    log.append('seed');
    const contractClient = createTestWire(api, { output: () => log }).client;
    const writes: string[] = [];

    const replica = createLiveLogReplicaCache(api.output, contractClient.output, {
      store: () => ({
        reset: (data) => {
          writes.push(`reset:${data.text}`);
        },
        append: (chunk) => {
          writes.push(`append:${chunk}`);
        },
      }),
    });
    const lease = replica.acquire(key);
    const output = await lease.ready();

    expect(() => output.text()).toThrow('write-only LogSink');
    log.append('\nnext');
    await waitFor(() => writes.length === 2);
    expect(writes).toEqual(['reset:seed', 'append:\nnext']);

    await lease.release();
    await replica.dispose();
  });

  it('serves downstream clients from the local log buffer', async () => {
    const key = { id: 'session' };
    const log = new LiveLogSource({ generation: 1000 });
    const upstream = createTestWire(api, { output: () => log }).client;
    const replica = createLiveLogReplicaCache(api.output, upstream.output);
    const downstream = createTestWire(api, { output: replica }).client;

    const handle = downstream.output.handle(key);
    const updates: string[] = [];
    const detach = await handle.attach((update) => {
      updates.push((update.delta as { chunk: string }).chunk);
    });
    await handle.snapshot();
    log.append('served\n');
    await waitFor(() => updates.length === 1);

    expect((await handle.snapshot()).data.text).toBe('served\n');

    detach();
    await replica.dispose();
  });
});

describe('ReplicaLog park and resume', () => {
  function setup(options: { maxBufferBytes?: number } = {}) {
    const log = new LiveLogSource({ generation: 1000, maxBufferBytes: options.maxBufferBytes });
    let subscribers = 0;
    const subscribe = log.subscribe.bind(log);
    log.subscribe = (cb) => {
      subscribers += 1;
      const off = subscribe(cb);
      return () => {
        subscribers -= 1;
        off();
      };
    };
    const wire = createTestWire(api, { output: () => log });
    const writes: string[] = [];
    const resets: LiveLogSnapshotData[] = [];
    const store: LogSink = {
      reset(data) {
        resets.push(data);
        writes.push(`reset:${data.text}`);
      },
      append(chunk) {
        writes.push(`append:${chunk}`);
      },
    };
    const replica = new ReplicaLog(wire.client.output.handle({ id: 'session' }), { store });
    return { log, replica, writes, resets, subscribers: () => subscribers, wire };
  }

  async function seeded(options: { maxBufferBytes?: number } = {}) {
    const fixture = setup(options);
    fixture.log.append('seed');
    await fixture.replica.ready;
    await waitFor(() => fixture.subscribers() === 1);
    expect(fixture.writes).toEqual(['reset:seed']);
    return fixture;
  }

  // Memory transports deliver on microtasks; a macrotask hop proves nothing is pending.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('releases the source subscription and stops delivering updates while parked', async () => {
    const { log, replica, writes, subscribers } = await seeded();

    await replica.park();
    await waitFor(() => subscribers() === 0);
    log.append('hidden');
    await settle();

    expect(writes).toEqual(['reset:seed']);
    await replica.dispose();
  });

  it('appends exactly the missed bytes on resume within the retained window', async () => {
    const { log, replica, writes, subscribers } = await seeded();

    await replica.park();
    await waitFor(() => subscribers() === 0);
    log.append('hidden ');
    log.append('output');
    await replica.resume();
    await waitFor(() => writes.length === 2);
    log.append('\nlive');
    await waitFor(() => writes.length === 3);

    expect(writes).toEqual(['reset:seed', 'append:hidden output', 'append:\nlive']);
    expect(subscribers()).toBe(1);
    await replica.dispose();
  });

  it('appends the whole retained tail when the gap ends exactly at the retention boundary', async () => {
    const { log, replica, writes } = await seeded({ maxBufferBytes: 4 });

    await replica.park();
    // Evicts 'seed': the retained tail now starts precisely at the replica offset.
    log.append('gap!');
    expect(log.snapshot().data).toEqual({ baseOffset: 4, text: 'gap!', truncated: true });
    await replica.resume();
    await waitFor(() => writes.length === 2);

    expect(writes).toEqual(['reset:seed', 'append:gap!']);
    await replica.dispose();
  });

  it('resets once to the retained tail when the source truncated past the replica offset', async () => {
    const { log, replica, writes, resets } = await seeded({ maxBufferBytes: 4 });

    await replica.park();
    log.append('gone');
    log.append('tail');
    expect(log.snapshot().data).toEqual({ baseOffset: 8, text: 'tail', truncated: true });
    await replica.resume();
    await waitFor(() => writes.length === 2);
    log.append('live');
    await waitFor(() => writes.length === 3);

    expect(writes).toEqual(['reset:seed', 'reset:tail', 'append:live']);
    expect(resets[1]).toEqual({ baseOffset: 8, text: 'tail', truncated: true });
    await replica.dispose();
  });

  it('treats repeated park and resume calls as no-ops', async () => {
    const { log, replica, writes, subscribers } = await seeded();

    await replica.resume();
    await settle();
    expect(subscribers()).toBe(1);

    await Promise.all([replica.park(), replica.park()]);
    await replica.park();
    await waitFor(() => subscribers() === 0);

    await Promise.all([replica.resume(), replica.resume()]);
    await replica.resume();
    await waitFor(() => subscribers() === 1);
    await settle();
    log.append('once');
    await waitFor(() => writes.length === 2);
    await settle();

    expect(writes).toEqual(['reset:seed', 'append:once']);
    expect(subscribers()).toBe(1);
    await replica.dispose();
  });

  it('lets the last of a racing park and resume win', async () => {
    const { log, replica, writes, subscribers } = await seeded();

    await Promise.all([replica.park(), replica.resume()]);
    await settle();
    expect(subscribers()).toBe(1);
    log.append('attached');
    await waitFor(() => writes.length === 2);

    await Promise.all([replica.resume(), replica.park()]);
    await settle();
    expect(subscribers()).toBe(0);
    log.append('parked');
    await settle();

    expect(writes).toEqual(['reset:seed', 'append:attached']);
    await replica.dispose();
  });

  it('keeps park and resume inert after dispose and detaches from any state', async () => {
    const parked = await seeded();
    await parked.replica.park();
    await parked.replica.dispose();
    await parked.replica.resume();
    await settle();
    expect(parked.subscribers()).toBe(0);
    parked.log.append('after');
    await settle();
    expect(parked.writes).toEqual(['reset:seed']);

    const attached = await seeded();
    await attached.replica.dispose();
    await waitFor(() => attached.subscribers() === 0);
    await attached.replica.park();
    await attached.replica.resume();
    await settle();
    expect(attached.subscribers()).toBe(0);
  });
});
