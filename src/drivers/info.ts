import pgPkg from 'pg/package.json';
import mysqlPkg from 'mysql2/package.json';
import sqlitePkg from 'node-sqlite3-wasm/package.json';
import type { DriverId } from '../core/types';

/** Bundled driver name and version, for the data source Information tab. */
export function driverDisplay(driver: DriverId): string {
  switch (driver) {
    case 'postgres':
      return `node-postgres (ver. ${pgPkg.version})`;
    case 'mysql':
      return `mysql2 (ver. ${mysqlPkg.version})`;
    case 'sqlite':
      return `node-sqlite3-wasm (ver. ${sqlitePkg.version})`;
  }
}

/** "PostgreSQL 17.9" → "PostgreSQL (ver. 17.9)", the IntelliJ info format. */
export function dbmsDisplay(serverVersion: string): string {
  const match = /^(\S+)\s+(.+)$/.exec(serverVersion.trim());
  return match ? `${match[1]} (ver. ${match[2]})` : serverVersion;
}
