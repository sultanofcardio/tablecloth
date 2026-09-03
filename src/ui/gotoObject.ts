import * as vscode from 'vscode';
import type { CatalogModel, StoredDataSource } from '../core/types';
import type { DataSourceStore } from '../data/store';
import type { SessionManager } from '../drivers/sessions';
import type { DdlKind } from '../sql/ddl';
import { nodeIds, type ExplorerRef } from './explorerModel';

export interface GoToObjectActions {
  openTable(ref: ExplorerRef): Promise<void>;
  openDdl(ds: StoredDataSource, ref: { kind: DdlKind; schema?: string; name: string }): Promise<void>;
  reveal(nodeId: string): Promise<void>;
}

type Kind = 'schema' | 'table' | 'view' | 'column' | 'routine' | 'sequence' | 'enum';

interface ObjectItem extends vscode.QuickPickItem {
  ds: StoredDataSource;
  objectKind: Kind;
  nodeId: string;
  ref: ExplorerRef;
  ddlSchema?: string;
}

const ICONS: Record<Kind, string> = {
  schema: 'symbol-namespace',
  table: 'table',
  view: 'eye',
  column: 'symbol-field',
  routine: 'symbol-method',
  sequence: 'symbol-number',
  enum: 'symbol-enum',
};

function itemsFor(ds: StoredDataSource, catalog: CatalogModel): ObjectItem[] {
  const items: ObjectItem[] = [];
  const dsId = ds.config.id;
  for (const db of catalog.databases) {
    for (const schema of db.schemas) {
      const path = [ds.config.name, db.name];
      if (!schema.implicit) path.push(schema.name);
      const where = path.join(' › ');
      const schemaRef = schema.implicit ? undefined : schema.name;
      const ddlSchema = ds.config.driver === 'mysql' ? db.name : schemaRef;
      const push = (kind: Kind, name: string, nodeId: string, ref: ExplorerRef, detail?: string) =>
        items.push({ label: `$(${ICONS[kind]}) ${name}`, description: where, detail, ds, objectKind: kind, nodeId, ref, ddlSchema });
      if (!schema.implicit) {
        push('schema', schema.name, nodeIds.schema(dsId, db.name, schema.name), { dsId, db: db.name, schema: schemaRef }, 'schema');
      }
      for (const rel of schema.relations) {
        const ref: ExplorerRef = { dsId, db: db.name, schema: schemaRef, name: rel.name };
        push(rel.kind === 'view' ? 'view' : 'table', rel.name, nodeIds.relation(dsId, db.name, schema.name, rel.name), ref, rel.kind);
        for (const column of rel.columns) {
          push(
            'column',
            `${rel.name}.${column.name}`,
            nodeIds.column(dsId, db.name, schema.name, rel.name, column.name),
            { dsId, db: db.name, schema: schemaRef, name: rel.name, leaf: column.name },
            `${column.dataType}${column.primaryKey ? ' · PK' : ''}${column.foreignKeyTarget ? ` · FK → ${column.foreignKeyTarget}` : ''}`,
          );
        }
      }
      for (const routine of schema.routines) {
        push('routine', routine.name, nodeIds.routine(dsId, db.name, schema.name, routine.name), { dsId, db: db.name, schema: schemaRef, name: routine.name }, `${routine.kind}${routine.args ?? ''}`);
      }
      for (const seq of schema.sequences) {
        push('sequence', seq.name, nodeIds.sequence(dsId, db.name, schema.name, seq.name), { dsId, db: db.name, schema: schemaRef, name: seq.name }, 'sequence');
      }
      for (const enumType of schema.enums) {
        push('enum', enumType.name, nodeIds.enumType(dsId, db.name, schema.name, enumType.name), { dsId, db: db.name, schema: schemaRef, name: enumType.name }, `enum (${enumType.values.join(', ')})`);
      }
    }
  }
  return items;
}

/** ⌘⇧O: fuzzy search every introspected object; opens tables, reveals the rest. */
export async function goToObject(store: DataSourceStore, sessions: SessionManager, actions: GoToObjectActions): Promise<void> {
  const items: ObjectItem[] = [];
  for (const ds of store.list()) {
    const catalog = sessions.getCatalog(ds.config.id);
    if (catalog) items.push(...itemsFor(ds, catalog));
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage('Nothing introspected yet. Expand a data source in the Database view first.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Go to database object (tables, columns, routines, types…)',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  await actions.reveal(picked.nodeId);
  switch (picked.objectKind) {
    case 'table':
    case 'view':
    case 'column':
      await actions.openTable(picked.ref);
      break;
    case 'routine':
    case 'sequence':
    case 'enum':
      await actions.openDdl(picked.ds, { kind: picked.objectKind, schema: picked.ddlSchema, name: picked.ref.name! });
      break;
  }
}
