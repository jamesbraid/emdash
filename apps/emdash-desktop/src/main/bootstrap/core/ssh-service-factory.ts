import type { ShellEnvManager } from '@emdash/core/services/shell-env/node';
import type { Scope } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import {
  MachinesService,
  type MachinesServiceDeps,
} from '@core/features/machines/api/node/machines-service';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import type { AppDb } from '@core/services/app-db/node/db';
import { resolveSshConfig } from '@core/services/ssh/node/config/resolve-ssh-config';
import { parseSshConfigFile } from '@core/services/ssh/node/config/sshConfigParser';
import { createProductionSshConnectConfigResolver } from '@core/services/ssh/node/connect/production-connect-config';
import type {
  SshConnectInput,
  SshConnectResult,
} from '@core/services/ssh/node/connect/resolve-ssh-connect-config';
import { SshConnectionsModel } from '@core/services/ssh/node/connections-model';
import type { SshCredentialService } from '@core/services/ssh/node/credentials/ssh-credential-service';
import { SshConnectionManager } from '@core/services/ssh/node/lifecycle/ssh-connection-manager';
import { SshService, type SshServiceDeps } from '@core/services/ssh/node/ssh-service';

const DEGRADED_SHELL_ENV_HINT =
  'login-shell environment was not captured; SSH_AUTH_SOCK may be wrong';

export interface CreateSshServiceDeps {
  scope: Scope;
  db: AppDb;
  credentials: SshCredentialService;
  prepareCredentials: MachinesServiceDeps['prepareCredentials'];
  /** The host login-shell environment that connect configs read SSH_AUTH_SOCK from. */
  shellEnv: Pick<ShellEnvManager, 'ensureFresh' | 'isDegraded'>;
  logger: Logger;
  telemetry: SshServiceDeps['telemetry'];
}

export function createSshService(deps: CreateSshServiceDeps): SshServiceHandle {
  const scope = deps.scope.child('ssh-service');
  const connections = scope.use(new SshConnectionsModel());
  const resolveProductionConnectConfig = createProductionSshConnectConfigResolver(deps.credentials);
  // A boot-time capture that timed out leaves launchd's SSH_AUTH_SOCK in process.env, and
  // that is the agent ssh2 would be handed. Give the login shell another chance first.
  const resolveConnectConfig = async (input: SshConnectInput): Promise<SshConnectResult> => {
    await deps.shellEnv.ensureFresh().catch((error: unknown) => {
      deps.logger.warn('[shell-env] Re-capture before SSH connect failed', {
        error: String(error),
      });
    });
    return await resolveProductionConnectConfig(input);
  };
  const manager = new SshConnectionManager({
    publishEvent: (event) => connections.publishEvent(event),
    log: deps.logger,
    authFailureHint: (config) =>
      config.agent && deps.shellEnv.isDegraded() ? DEGRADED_SHELL_ENV_HINT : undefined,
  });
  const ssh = new SshService({
    db: deps.db,
    manager,
    runtime: connections,
    resolveConnectConfig,
    parseSshConfigFile,
    resolveSshConfig,
    telemetry: deps.telemetry,
    log: deps.logger,
  });
  const machines = new MachinesService({
    db: deps.db,
    credentials: deps.credentials,
    prepareCredentials: deps.prepareCredentials,
    ssh,
    log: deps.logger,
  });

  scope.add(() => manager.disconnectAll());

  let disposePromise: Promise<void> | undefined;
  return {
    control: ssh.control,
    bindLifecycle: (lifecycle) => ssh.bindLifecycle(lifecycle),
    ssh,
    machines,
    manager,
    connections,
    dispose() {
      disposePromise ??= scope.dispose();
      return disposePromise;
    },
  };
}
