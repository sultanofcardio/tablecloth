export type DriverId = 'postgres' | 'mysql' | 'sqlite';

export type EnvColor = 'none' | 'green' | 'amber' | 'red' | 'blue' | 'purple';

export type AuthMode = 'userPassword' | 'pgpass' | 'none';

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export type SshAuthMode = 'password' | 'keyFile' | 'agent';

/** Where a data source definition is stored: user settings or workspace settings. */
export type StorageScope = 'global' | 'project';

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: SshAuthMode;
  keyFile?: string;
}

export interface SslConfig {
  mode: SslMode;
  caFile?: string;
}

export interface DataSourceConfig {
  id: string;
  name: string;
  driver: DriverId;
  color: EnvColor;
  readOnly: boolean;
  /** Re-introspect automatically when the schema might have changed (on connect). */
  autoSync: boolean;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  auth: AuthMode;
  /** SQLite database file path. */
  file?: string;
  ssl?: SslConfig;
  ssh?: SshConfig;
  /** Schemas (Postgres) or databases (MySQL) selected for introspection. Empty = driver default. */
  schemas?: string[];
}

export interface StoredDataSource {
  config: DataSourceConfig;
  scope: StorageScope;
}

/** Secrets attached to a data source, held in VS Code SecretStorage. */
export interface DataSourceSecrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  name: string;
  /** Best-effort type display, e.g. "bigint", "varchar(64)". */
  dataType?: string;
  /** Right-align and treat as numeric in the grid. */
  numeric?: boolean;
}

/** Cell values are normalized before leaving the driver layer. */
export type CellValue = string | number | boolean | null;

export interface QueryResult {
  columns: ColumnInfo[];
  rows: CellValue[][];
  /** Rows affected for DML; null when not applicable. */
  affectedRows: number | null;
  /** True when the statement produced a row set (even an empty one). */
  hasRows: boolean;
}

// ---------------------------------------------------------------------------
// Introspected schema model
// ---------------------------------------------------------------------------

export type RelationKind = 'table' | 'view';

export interface ColumnModel {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Present when the column is part of a foreign key; target is "table" or "schema.table". */
  foreignKeyTarget?: string;
  /** The referenced column of that foreign key (single-column keys). */
  foreignKeyColumn?: string;
  default?: string;
  /** The database produces the value on insert (identity, serial, auto_increment, rowid alias). */
  autoIncrement?: boolean;
  /** Computed by the database from other columns; never writable. */
  generated?: boolean;
}

export interface IndexModel {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface RelationModel {
  name: string;
  kind: RelationKind;
  columns: ColumnModel[];
  indexes: IndexModel[];
}

export interface RoutineModel {
  name: string;
  kind: 'function' | 'procedure';
  /** Display-friendly argument list, e.g. "(integer, text)". */
  args?: string;
}

export interface EnumTypeModel {
  name: string;
  values: string[];
}

export interface SequenceModel {
  name: string;
}

export interface SchemaModel {
  name: string;
  /** MySQL databases and SQLite have no separate schema level; the tree skips implicit schemas. */
  implicit: boolean;
  relations: RelationModel[];
  routines: RoutineModel[];
  enums: EnumTypeModel[];
  sequences: SequenceModel[];
}

export interface DatabaseModel {
  name: string;
  /** Introspected schemas. */
  schemas: SchemaModel[];
  /** Names of all schemas that exist, introspected or not (for the "1 of 3" badge). */
  allSchemaNames: string[];
}

export interface CatalogModel {
  databases: DatabaseModel[];
  /** Every database name visible on the server, introspected or not (MySQL). */
  allDatabaseNames?: string[];
  introspectedAt: number;
  serverVersion: string;
}

// ---------------------------------------------------------------------------
// Console transaction state
// ---------------------------------------------------------------------------

export type TxMode = 'auto' | 'manual';

export type TxIsolation = 'default' | 'read-committed' | 'repeatable-read' | 'serializable';

export interface TxState {
  mode: TxMode;
  isolation: TxIsolation;
}

export const TX_ISOLATION_LABELS: Record<TxIsolation, string> = {
  default: 'Database Default',
  'read-committed': 'Read Committed',
  'repeatable-read': 'Repeatable Read',
  serializable: 'Serializable',
};

// ---------------------------------------------------------------------------
// Console bindings
// ---------------------------------------------------------------------------

export interface ConsoleBinding {
  dataSourceId: string;
  /** Database context (MySQL database, Postgres database — informational for PG). */
  database?: string;
  /** Default schema for completion and qualification (PG: usually "public"). */
  schema?: string;
}

export const ENV_COLOR_HEX: Record<Exclude<EnvColor, 'none'>, string> = {
  green: '#57965c',
  amber: '#d6ae58',
  red: '#f75464',
  blue: '#3574f0',
  purple: '#b189f5',
};

export const ENV_COLOR_DOT: Record<EnvColor, string> = {
  none: '',
  green: '🟢',
  amber: '🟡',
  red: '🔴',
  blue: '🔵',
  purple: '🟣',
};
