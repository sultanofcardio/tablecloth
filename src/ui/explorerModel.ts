import type { CatalogModel, DatabaseModel, SchemaModel, StoredDataSource } from '../core/types';
import { ENV_COLOR_HEX } from '../core/types';

export type ExplorerNodeKind =
  | 'dataSource'
  | 'database'
  | 'schema'
  | 'group'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'routine'
  | 'enum'
  | 'enumValue'
  | 'sequence'
  | 'error'
  | 'empty';

/** Action target carried by a node, enough to reconstruct host-side context. */
export interface ExplorerRef {
  dsId: string;
  db?: string;
  schema?: string;
  name?: string;
}

export interface ExplorerNode {
  id: string;
  kind: ExplorerNodeKind;
  label: string;
  /** Right-aligned dim text: type info, "read-only 🔒", "MySQL". */
  meta?: string;
  /** Bordered count chip, e.g. "1 of 3". */
  chip?: string;
  /** Plain dim count for groups. */
  count?: number;
  envColor?: string | null;
  vendor?: 'postgres' | 'mysql' | 'sqlite';
  /** Expandable but not yet introspected (expanding triggers introspection). */
  lazy?: boolean;
  /** Column key markers, for the gold/blue key icons. */
  pk?: boolean;
  fk?: boolean;
  ref?: ExplorerRef;
  children?: ExplorerNode[];
}

export interface ExplorerDeps {
  getCatalog(dsId: string): CatalogModel | undefined;
  isConnected(dsId: string): boolean;
}

const GROUPS = ['tables', 'views', 'sequences', 'routines', 'object types'] as const;

/** Serialize the explorer tree for the webview from store + session state. */
export function buildExplorerTree(sources: StoredDataSource[], deps: ExplorerDeps): ExplorerNode[] {
  if (sources.length === 0) {
    return [{ id: 'empty', kind: 'empty', label: 'No data sources. Click + to add one.' }];
  }
  return sources.map((ds) => dataSourceNode(ds, deps));
}

function dataSourceNode(ds: StoredDataSource, deps: ExplorerDeps): ExplorerNode {
  const { config } = ds;
  const catalog = deps.getCatalog(config.id);
  const metaParts: string[] = [];
  if (catalog?.serverVersion) metaParts.push(catalog.serverVersion);
  if (config.readOnly) metaParts.push('read-only 🔒');
  if (ds.scope === 'project') metaParts.push('project');

  const node: ExplorerNode = {
    id: `ds:${config.id}`,
    kind: 'dataSource',
    label: config.name,
    meta: metaParts.join(' · ') || undefined,
    envColor: config.color === 'none' ? null : ENV_COLOR_HEX[config.color],
    vendor: config.driver,
    ref: { dsId: config.id },
  };
  if (!catalog) {
    node.lazy = true;
    return node;
  }
  node.children = catalog.databases.map((db) => databaseNode(config.id, db));
  if (node.children.length === 0) {
    node.children = [{ id: `ds:${config.id}:none`, kind: 'empty', label: 'nothing introspected' }];
  }
  return node;
}

function databaseNode(dsId: string, db: DatabaseModel): ExplorerNode {
  const implicit = db.schemas.length === 1 && db.schemas[0]!.implicit;
  const introspected = db.schemas.length;
  const total = db.allSchemaNames.length;
  const node: ExplorerNode = {
    id: `db:${dsId}:${db.name}`,
    kind: 'database',
    label: db.name,
    chip: !implicit && total > introspected ? `${introspected} of ${total}` : undefined,
    ref: { dsId, db: db.name },
  };
  node.children = implicit
    ? schemaChildren(dsId, db.name, db.schemas[0]!)
    : db.schemas.map((schema) => ({
        id: `schema:${dsId}:${db.name}:${schema.name}`,
        kind: 'schema' as const,
        label: schema.name,
        ref: { dsId, db: db.name, schema: schema.name },
        children: schemaChildren(dsId, db.name, schema),
      }));
  return node;
}

function schemaChildren(dsId: string, dbName: string, schema: SchemaModel): ExplorerNode[] {
  const schemaRef = schema.implicit ? undefined : schema.name;
  const base = `grp:${dsId}:${dbName}:${schema.name}`;
  const nodes: ExplorerNode[] = [];

  for (const group of GROUPS) {
    const children = groupChildren(dsId, dbName, schemaRef, schema, group);
    if (children.length === 0 && group !== 'tables') continue;
    nodes.push({
      id: `${base}:${group}`,
      kind: 'group',
      label: group,
      count: children.length,
      children,
      ref: { dsId, db: dbName, schema: schemaRef },
    });
  }
  return nodes;
}

function groupChildren(
  dsId: string,
  dbName: string,
  schemaRef: string | undefined,
  schema: SchemaModel,
  group: (typeof GROUPS)[number],
): ExplorerNode[] {
  const base = `obj:${dsId}:${dbName}:${schema.name}`;
  switch (group) {
    case 'tables':
    case 'views': {
      const kind = group === 'tables' ? 'table' : 'view';
      return schema.relations
        .filter((r) => (group === 'tables' ? r.kind === 'table' : r.kind === 'view'))
        .map((rel) => ({
          id: `${base}:rel:${rel.name}`,
          kind: kind as 'table' | 'view',
          label: rel.name,
          ref: { dsId, db: dbName, schema: schemaRef, name: rel.name },
          children: [
            ...rel.columns.map((col): ExplorerNode => {
              const parts = [col.dataType];
              if (col.primaryKey) parts.push('PK');
              if (col.foreignKeyTarget) parts.push(`FK → ${col.foreignKeyTarget}`);
              if (!col.nullable && !col.primaryKey) parts.push('not null');
              return {
                id: `${base}:col:${rel.name}:${col.name}`,
                kind: 'column',
                label: col.name,
                meta: parts.join(' · '),
                pk: col.primaryKey,
                fk: !!col.foreignKeyTarget,
                ref: { dsId, db: dbName, schema: schemaRef, name: `${rel.name}.${col.name}` },
              };
            }),
            ...rel.indexes.map((index) => ({
              id: `${base}:idx:${rel.name}:${index.name}`,
              kind: 'index' as const,
              label: index.name,
              meta: `(${index.columns.join(', ')})${index.unique ? ' · unique' : ''}`,
              ref: { dsId, db: dbName, schema: schemaRef, name: index.name },
            })),
          ],
        }));
    }
    case 'sequences':
      return schema.sequences.map((seq) => ({
        id: `${base}:seq:${seq.name}`,
        kind: 'sequence',
        label: seq.name,
        ref: { dsId, db: dbName, schema: schemaRef, name: seq.name },
      }));
    case 'routines':
      return schema.routines.map((routine) => ({
        id: `${base}:fn:${routine.name}`,
        kind: 'routine',
        label: routine.name,
        meta: `${routine.args ?? ''} · ${routine.kind}`.replace(/^ · /, ''),
        ref: { dsId, db: dbName, schema: schemaRef, name: routine.name },
      }));
    case 'object types':
      return schema.enums.map((enumType) => ({
        id: `${base}:enum:${enumType.name}`,
        kind: 'enum',
        label: enumType.name,
        ref: { dsId, db: dbName, schema: schemaRef, name: enumType.name },
        children: enumType.values.map((value, i) => ({
          id: `${base}:enumv:${enumType.name}:${i}`,
          kind: 'enumValue',
          label: value,
        })),
      }));
  }
}
