import { createServer } from 'node:net';
import { createScope } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@core/services/app-db/node/db';
import type { SshCredentialService } from '@core/services/ssh/node/credentials/ssh-credential-service';
import { SshConnectionManager } from '@core/services/ssh/node/lifecycle/ssh-connection-manager';
import { createSshService, type CreateSshServiceDeps } from './ssh-service-factory';

function createDeps(): CreateSshServiceDeps {
  const credentials = {
    getPassword: vi.fn(async () => null),
    getPassphrase: vi.fn(async () => null),
    storePassword: vi.fn(),
    storePassphrase: vi.fn(),
    deleteAllCredentials: vi.fn(),
  } as unknown as SshCredentialService;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return {
    scope: createScope({ label: 'ssh-factory-test' }),
    db: {} as AppDb,
    credentials,
    prepareCredentials: () => () => {},
    shellEnv: { ensureFresh: vi.fn(async () => {}), isDegraded: () => false },
    logger,
    telemetry: { capture: vi.fn() },
  };
}

/** A port nothing listens on, so a connect attempt is refused instead of handshaking. */
async function closedLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

describe('createSshService', () => {
  it('owns a child scope and disconnects the manager exactly once', async () => {
    const deps = createDeps();
    const disconnectAll = vi
      .spyOn(SshConnectionManager.prototype, 'disconnectAll')
      .mockResolvedValue();

    const handle = createSshService(deps);

    expect(handle.ssh).toBeDefined();
    expect(handle.machines).toBeDefined();
    // The handle exposes the primitive interface; narrow to the concrete class
    // to drive the implementation-private createConnection path.
    const manager = handle.manager;
    if (!(manager instanceof SshConnectionManager)) {
      throw new Error('expected the concrete SshConnectionManager');
    }
    await expect(
      manager.createConnection('ssh-1', async () => {
        throw new Error('Resolver failed');
      })
    ).rejects.toThrow('Resolver failed');
    expect(handle.connections.snapshot()['ssh-1']).toEqual({
      state: 'connecting',
      health: { status: 'ok' },
    });

    await handle.dispose();
    await handle.dispose();
    await deps.scope.dispose();

    expect(disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('gives the login-shell environment one more chance before resolving a connection', async () => {
    const deps = createDeps();
    const handle = createSshService(deps);
    const port = await closedLocalPort();

    const result = await handle.ssh.testConnection({
      id: '',
      name: 'closed-port',
      host: '127.0.0.1',
      port,
      username: 'alice',
      authType: 'password',
      password: 'secret',
    });

    expect(deps.shellEnv.ensureFresh).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected the connection to be refused');
    expect(result.error).toContain('ECONNREFUSED');

    await handle.dispose();
    await deps.scope.dispose();
  });
});
