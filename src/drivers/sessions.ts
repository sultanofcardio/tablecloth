import type { CatalogModel, DataSourceConfig, DataSourceSecrets } from '../core/types';
import { getDriver } from './index';
import type { DbSession } from './driver';

export interface SessionDeps {
  getSecrets(dataSourceId: string): Promise<DataSourceSecrets>;
  showSystemSchemas(): boolean;
}

type Listener = (dataSourceId: string) => void;

interface Managed {
  session: DbSession;
  config: DataSourceConfig;
  queue: Promise<unknown>;
}

/** The session used for introspection, table browsing, and unbound runs. */
const MAIN_SESSION = 'main';

function sessionKey(dataSourceId: string, suffix: string): string {
  return `${dataSourceId}::${suffix}`;
}

/**
 * Live sessions per data source. The main session serves introspection and
 * table grids; each query console gets its own session (keyed by its document)
 * so a console's manual transaction never leaks into other work. All work on
 * one session is serialized in arrival order.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Promise<Managed>>();
  private readonly catalogs = new Map<string, CatalogModel>();
  private readonly listeners: Listener[] = [];

  constructor(private readonly deps: SessionDeps) {}

  onDidChange(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private fire(dataSourceId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(dataSourceId);
      } catch {
        // listeners must not break session management
      }
    }
  }

  isConnected(dataSourceId: string): boolean {
    const prefix = `${dataSourceId}::`;
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  getCatalog(dataSourceId: string): CatalogModel | undefined {
    return this.catalogs.get(dataSourceId);
  }

  private async ensure(config: DataSourceConfig, suffix: string): Promise<Managed> {
    const key = sessionKey(config.id, suffix);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const pending = (async (): Promise<Managed> => {
      const driver = getDriver(config.driver);
      const secrets = await this.deps.getSecrets(config.id);
      const session = await driver.connect({ config, secrets });
      return { session, config, queue: Promise.resolve() };
    })();

    this.sessions.set(key, pending);
    try {
      const managed = await pending;
      this.fire(config.id);
      return managed;
    } catch (err) {
      this.sessions.delete(key);
      throw err;
    }
  }

  /** Run `fn` on the data source's session for `suffix`, serialized with other work on it. */
  async run<T>(
    config: DataSourceConfig,
    fn: (session: DbSession) => Promise<T>,
    suffix: string = MAIN_SESSION,
  ): Promise<T> {
    const managed = await this.ensure(config, suffix);
    const task = managed.queue.then(
      () => fn(managed.session),
      () => fn(managed.session),
    );
    managed.queue = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } catch (err) {
      // A dead connection poisons every later statement; drop it so the next
      // run reconnects instead of failing forever.
      if (isConnectionError(err)) {
        await this.closeKey(sessionKey(config.id, suffix));
        this.fire(config.id);
      }
      throw err;
    }
  }

  /** Connect (if needed) and introspect, caching the resulting catalog. */
  async introspect(config: DataSourceConfig, force = false): Promise<CatalogModel> {
    const cached = this.catalogs.get(config.id);
    if (cached && !force) return cached;
    const driver = getDriver(config.driver);
    const catalog = await this.run(config, (session) =>
      driver.introspect(session, config, this.deps.showSystemSchemas()),
    );
    this.catalogs.set(config.id, catalog);
    this.fire(config.id);
    return catalog;
  }

  async serverVersion(config: DataSourceConfig): Promise<string> {
    const managed = await this.ensure(config, MAIN_SESSION);
    return managed.session.serverVersion;
  }

  private async closeKey(key: string): Promise<void> {
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (pending) {
      try {
        const managed = await pending;
        await managed.session.close();
      } catch {
        // already broken; nothing to close
      }
    }
  }

  /** Close one console's session (e.g. its document was closed). */
  async closeSession(dataSourceId: string, suffix: string): Promise<void> {
    await this.closeKey(sessionKey(dataSourceId, suffix));
  }

  /** Close every session of a data source and drop its catalog. */
  async disconnect(dataSourceId: string): Promise<void> {
    const prefix = `${dataSourceId}::`;
    const keys = [...this.sessions.keys()].filter((k) => k.startsWith(prefix));
    this.catalogs.delete(dataSourceId);
    await Promise.all(keys.map((k) => this.closeKey(k)));
    this.fire(dataSourceId);
  }

  async disconnectAll(): Promise<void> {
    const ids = new Set([...this.sessions.keys()].map((k) => k.split('::')[0]!));
    await Promise.all([...ids].map((id) => this.disconnect(id)));
  }

  /** Drop the sessions when their configuration changed under them. */
  async invalidate(dataSourceId: string): Promise<void> {
    if (this.isConnected(dataSourceId)) {
      await this.disconnect(dataSourceId);
    } else {
      this.catalogs.delete(dataSourceId);
      this.fire(dataSourceId);
    }
  }
}

const CONNECTION_ERROR_PATTERNS = [
  /connection terminated/i,
  /connection closed/i,
  /connection lost/i,
  /server closed the connection/i,
  /econnreset/i,
  /econnrefused/i,
  /epipe/i,
  /socket hang up/i,
  /client was closed/i,
];

function isConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message} ${(err as NodeJS.ErrnoException).code ?? ''}` : String(err);
  return CONNECTION_ERROR_PATTERNS.some((p) => p.test(message));
}
