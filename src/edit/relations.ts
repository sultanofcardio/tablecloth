// Catalog lookups behind FK navigation: where a foreign key points, and which
// tables point at a given one.
import type { CatalogModel, ColumnModel, DatabaseModel, RelationModel, SchemaModel } from '../core/types';

export interface RelationLocation {
  db: DatabaseModel;
  schema: SchemaModel;
  relation: RelationModel;
}

function sameName(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** Find a relation by name, preferring the given schema, then any schema. */
export function findRelation(
  catalog: CatalogModel,
  schemaName: string | undefined,
  table: string,
): RelationLocation | undefined {
  let fallback: RelationLocation | undefined;
  for (const db of catalog.databases) {
    for (const schema of db.schemas) {
      const relation = schema.relations.find((r) => sameName(r.name, table));
      if (!relation) continue;
      if (schemaName && sameName(schema.name, schemaName)) return { db, schema, relation };
      if (!schemaName && (schema.name === 'public' || schema.implicit)) return { db, schema, relation };
      fallback ??= { db, schema, relation };
    }
  }
  return fallback;
}

/**
 * Resolve a column's foreign key target ("table" or "schema.table" relative
 * to the owning schema) to the relation and the referenced column, falling
 * back to the target's single-column primary key when the referenced column
 * is unknown.
 */
export function resolveForeignKey(
  catalog: CatalogModel,
  ownerSchema: string | undefined,
  column: Pick<ColumnModel, 'foreignKeyTarget' | 'foreignKeyColumn'>,
): (RelationLocation & { column: string }) | undefined {
  if (!column.foreignKeyTarget) return undefined;
  const dot = column.foreignKeyTarget.lastIndexOf('.');
  const targetSchema = dot >= 0 ? column.foreignKeyTarget.slice(0, dot) : ownerSchema;
  const targetTable = dot >= 0 ? column.foreignKeyTarget.slice(dot + 1) : column.foreignKeyTarget;
  const found = findRelation(catalog, targetSchema, targetTable);
  if (!found) return undefined;
  const referenced = column.foreignKeyColumn ?? found.relation.columns.find((c) => c.primaryKey)?.name;
  if (!referenced) return undefined;
  return { ...found, column: referenced };
}

export interface ReferencingColumn {
  db: DatabaseModel;
  schema: SchemaModel;
  relation: RelationModel;
  /** The foreign key column in the referencing table. */
  column: ColumnModel;
  /** The column of the referenced table the key points at. */
  viaColumn: string;
}

/** Every column in the catalog whose foreign key points at `table` in `schema`. */
export function referencingColumns(catalog: CatalogModel, schema: SchemaModel, table: RelationModel): ReferencingColumn[] {
  const out: ReferencingColumn[] = [];
  const primaryKey = table.columns.find((c) => c.primaryKey)?.name;
  for (const db of catalog.databases) {
    for (const s of db.schemas) {
      for (const relation of s.relations) {
        for (const column of relation.columns) {
          if (!column.foreignKeyTarget) continue;
          const dot = column.foreignKeyTarget.lastIndexOf('.');
          const targetSchema = dot >= 0 ? column.foreignKeyTarget.slice(0, dot) : s.name;
          const targetTable = dot >= 0 ? column.foreignKeyTarget.slice(dot + 1) : column.foreignKeyTarget;
          if (!sameName(targetTable, table.name)) continue;
          if (!sameName(targetSchema, schema.name)) continue;
          const viaColumn = column.foreignKeyColumn ?? primaryKey;
          if (!viaColumn) continue;
          out.push({ db, schema: s, relation, column, viaColumn });
        }
      }
    }
  }
  return out;
}
