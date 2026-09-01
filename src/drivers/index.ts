import type { DriverId } from '../core/types';
import type { Driver } from './driver';
import { mysqlDriver } from './mysql';
import { postgresDriver } from './postgres';
import { sqliteDriver } from './sqlite';

const DRIVERS: Record<DriverId, Driver> = {
  postgres: postgresDriver,
  mysql: mysqlDriver,
  sqlite: sqliteDriver,
};

export function getDriver(id: DriverId): Driver {
  const driver = DRIVERS[id];
  if (!driver) throw new Error(`Unknown driver: ${id}`);
  return driver;
}

export const ALL_DRIVERS: Driver[] = Object.values(DRIVERS);
