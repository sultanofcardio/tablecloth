import * as vscode from 'vscode';
import type { DataSourceConfig, DataSourceSecrets, StorageScope, StoredDataSource } from '../core/types';

const SETTING = 'tablecloth.dataSources';

const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

function secretKey(id: string, field: SecretField): string {
  return `tablecloth/${id}/${field}`;
}

function normalize(raw: any): DataSourceConfig | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.name !== 'string') return undefined;
  if (raw.driver !== 'postgres' && raw.driver !== 'mysql' && raw.driver !== 'sqlite') return undefined;
  return {
    id: raw.id,
    name: raw.name,
    driver: raw.driver,
    color: raw.color ?? 'none',
    readOnly: !!raw.readOnly,
    autoSync: raw.autoSync !== false,
    host: raw.host,
    port: typeof raw.port === 'number' ? raw.port : undefined,
    database: raw.database,
    user: raw.user,
    auth: raw.auth === 'pgpass' || raw.auth === 'none' ? raw.auth : 'userPassword',
    file: raw.file,
    ssl: raw.ssl && typeof raw.ssl === 'object' ? { mode: raw.ssl.mode ?? 'disable', caFile: raw.ssl.caFile } : undefined,
    ssh:
      raw.ssh && typeof raw.ssh === 'object'
        ? {
            enabled: !!raw.ssh.enabled,
            host: raw.ssh.host ?? '',
            port: typeof raw.ssh.port === 'number' ? raw.ssh.port : 22,
            user: raw.ssh.user ?? '',
            auth: raw.ssh.auth === 'keyFile' || raw.ssh.auth === 'agent' ? raw.ssh.auth : 'password',
            keyFile: raw.ssh.keyFile,
          }
        : undefined,
    schemas: Array.isArray(raw.schemas) ? raw.schemas.map(String) : undefined,
  };
}

/**
 * Data source definitions live in the `tablecloth.dataSources` setting: user
 * settings hold Global data sources, workspace settings hold Project ones.
 * Passwords never touch settings; they live in VS Code's SecretStorage.
 */
export class DataSourceStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly watcher: vscode.Disposable;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.watcher = vscode.Disposable.from(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SETTING)) this.emitter.fire();
      }),
      // Project data sources become visible once the workspace is trusted.
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.emitter.fire()),
    );
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }

  list(): StoredDataSource[] {
    const info = vscode.workspace.getConfiguration().inspect<any[]>(SETTING);
    const result: StoredDataSource[] = [];
    for (const raw of info?.globalValue ?? []) {
      const config = normalize(raw);
      if (config) result.push({ config, scope: 'global' });
    }
    // Workspace values are declared as a restricted configuration, so VS Code
    // already withholds them in Restricted Mode; the explicit check keeps that
    // guarantee independent of the manifest.
    if (vscode.workspace.isTrusted) {
      for (const raw of info?.workspaceValue ?? []) {
        const config = normalize(raw);
        if (config) result.push({ config, scope: 'project' });
      }
    }
    return result;
  }

  get(id: string): StoredDataSource | undefined {
    return this.list().find((s) => s.config.id === id);
  }

  private async writeScope(scope: StorageScope, values: DataSourceConfig[]): Promise<void> {
    const target = scope === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
    await vscode.workspace
      .getConfiguration()
      .update(SETTING, values.length > 0 ? values : undefined, target);
  }

  private scopeValues(scope: StorageScope): DataSourceConfig[] {
    return this.list()
      .filter((s) => s.scope === scope)
      .map((s) => s.config);
  }

  async save(config: DataSourceConfig, scope: StorageScope): Promise<void> {
    if (scope === 'project' && !vscode.workspace.isTrusted) {
      throw new Error('Project data sources are unavailable in Restricted Mode. Trust the workspace, or save it as a Global data source.');
    }
    const existing = this.get(config.id);
    if (existing && existing.scope !== scope) {
      // moved between global and project: remove from the old scope first
      await this.writeScope(
        existing.scope,
        this.scopeValues(existing.scope).filter((c) => c.id !== config.id),
      );
    }
    const values = this.scopeValues(scope).filter((c) => c.id !== config.id);
    values.push(config);
    values.sort((a, b) => a.name.localeCompare(b.name));
    await this.writeScope(scope, values);
  }

  async remove(id: string): Promise<void> {
    const existing = this.get(id);
    if (!existing) return;
    await this.writeScope(
      existing.scope,
      this.scopeValues(existing.scope).filter((c) => c.id !== id),
    );
    for (const field of SECRET_FIELDS) {
      await this.context.secrets.delete(secretKey(id, field));
    }
  }

  async getSecrets(id: string): Promise<DataSourceSecrets> {
    const [password, sshPassword, sshPassphrase] = await Promise.all(
      SECRET_FIELDS.map((f) => this.context.secrets.get(secretKey(id, f))),
    );
    return { password, sshPassword, sshPassphrase };
  }

  async setSecret(id: string, field: SecretField, value: string | undefined): Promise<void> {
    if (value === undefined || value === '') {
      await this.context.secrets.delete(secretKey(id, field));
    } else {
      await this.context.secrets.store(secretKey(id, field), value);
    }
  }

  async copySecrets(fromId: string, toId: string): Promise<void> {
    for (const field of SECRET_FIELDS) {
      const value = await this.context.secrets.get(secretKey(fromId, field));
      if (value !== undefined) await this.context.secrets.store(secretKey(toId, field), value);
    }
  }
}
