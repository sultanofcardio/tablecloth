// PostgreSQL catalog shapes that only exist from a given release. Both the
// introspection queries and the DDL generator read them, so the version test
// lives here rather than in either caller.

/** Major release of a "PostgreSQL 16.2" version string; an unreadable one counts as current. */
export function pgMajorVersion(serverVersion: string): number {
  const match = /(\d+)/.exec(serverVersion);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export interface PgCatalogSupport {
  /** pg_attribute.attidentity (10+). */
  identity: boolean;
  /** pg_attribute.attgenerated (12+). */
  generated: boolean;
  /** pg_proc.prokind (11+); before that, proisagg and proiswindow. */
  prokind: boolean;
  /** the pg_sequences view (10+); before that, the sequence relation itself. */
  pgSequences: boolean;
}

export function pgCatalogSupport(serverVersion: string): PgCatalogSupport {
  const major = pgMajorVersion(serverVersion);
  return {
    identity: major >= 10,
    generated: major >= 12,
    prokind: major >= 11,
    pgSequences: major >= 10,
  };
}
