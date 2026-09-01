import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { Client as SshClient, type ConnectConfig } from 'ssh2';
import type { DataSourceSecrets, SshConfig } from '../core/types';

export interface SshTunnel {
  stream: Duplex;
  dispose(): void;
}

/**
 * Open an SSH connection and a forwarded stream to the database host/port as
 * seen from the SSH server. The returned duplex stream is handed straight to
 * the database driver instead of a TCP socket.
 */
export function openSshTunnel(
  ssh: SshConfig,
  secrets: DataSourceSecrets,
  targetHost: string,
  targetPort: number,
): Promise<SshTunnel> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const config: ConnectConfig = {
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user,
      readyTimeout: 15_000,
    };
    if (ssh.auth === 'password') {
      config.password = secrets.sshPassword ?? '';
    } else if (ssh.auth === 'keyFile') {
      if (!ssh.keyFile) {
        reject(new Error('SSH key file is not configured.'));
        return;
      }
      try {
        config.privateKey = readFileSync(ssh.keyFile);
      } catch (err) {
        reject(new Error(`Cannot read SSH key file ${ssh.keyFile}: ${err instanceof Error ? err.message : err}`));
        return;
      }
      if (secrets.sshPassphrase) config.passphrase = secrets.sshPassphrase;
    } else {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) {
        reject(new Error('SSH agent authentication selected but SSH_AUTH_SOCK is not set.'));
        return;
      }
      config.agent = sock;
    }

    let settled = false;
    client.on('ready', () => {
      client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
        if (err) {
          settled = true;
          client.end();
          reject(new Error(`SSH forward to ${targetHost}:${targetPort} failed: ${err.message}`));
          return;
        }
        settled = true;
        stream.on('close', () => client.end());
        resolve({ stream, dispose: () => client.end() });
      });
    });
    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSH connection to ${ssh.host} failed: ${err.message}`));
      }
    });
    client.connect(config);
  });
}
