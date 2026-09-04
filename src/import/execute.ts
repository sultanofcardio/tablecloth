import type { DriverId } from '../core/types';
import type { DbSession } from '../drivers/driver';
import { errorMessage } from '../core/util';

export interface ImportExecution {
  dialect: DriverId;
  createSql?: string;
  dropSql?: string;
  batches: string[];
  batchRows: string[][][];
  rowSql(row: string[]): string;
  onError: 'stop' | 'skip';
  cancelled(): boolean;
  progressed(done: number): void;
}

export interface ImportExecutionResult {
  inserted: number;
  skipped: number;
  errors: string[];
}

export async function executeImport(session: DbSession, input: ImportExecution): Promise<ImportExecutionResult> {
  let inserted = 0;
  let skipped = 0;
  const errors: string[] = [];
  const completedRows: number[] = [];
  let totalCompleted = 0;
  for (const rows of input.batchRows) {
    totalCompleted += rows.length;
    completedRows.push(totalCompleted);
  }
  let mysqlTableCreated = false;
  const begin = input.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
  try {
    if (input.cancelled()) throw new Error('Import cancelled; nothing was written.');
    if (input.dialect === 'mysql' && input.createSql) {
      await session.query(input.createSql);
      mysqlTableCreated = true;
    }
    await session.query(begin);
    if (input.dialect !== 'mysql' && input.createSql) await session.query(input.createSql);
    for (const [i, batch] of input.batches.entries()) {
      if (input.cancelled()) throw new Error('Import cancelled; nothing was written.');
      const rows = input.batchRows[i] ?? [];
      try {
        if (input.onError === 'skip') await session.query('SAVEPOINT tablecloth_batch');
        await session.query(batch);
        if (input.onError === 'skip') await session.query('RELEASE SAVEPOINT tablecloth_batch');
        inserted += rows.length;
      } catch (err) {
        if (input.onError === 'stop') throw err;
        await session.query('ROLLBACK TO SAVEPOINT tablecloth_batch').catch(() => undefined);
        await session.query('RELEASE SAVEPOINT tablecloth_batch').catch(() => undefined);
        for (const [j, row] of rows.entries()) {
          try {
            await session.query('SAVEPOINT tablecloth_row');
            await session.query(input.rowSql(row));
            await session.query('RELEASE SAVEPOINT tablecloth_row');
            inserted++;
          } catch (rowErr) {
            await session.query('ROLLBACK TO SAVEPOINT tablecloth_row').catch(() => undefined);
            await session.query('RELEASE SAVEPOINT tablecloth_row').catch(() => undefined);
            skipped++;
            if (errors.length < 20) errors.push(`row ${(completedRows[i - 1] ?? 0) + j + 1}: ${errorMessage(rowErr)}`);
          }
        }
      }
      input.progressed(completedRows[i] ?? 0);
    }
    if (input.cancelled()) throw new Error('Import cancelled; nothing was written.');
    await session.query('COMMIT');
    return { inserted, skipped, errors };
  } catch (err) {
    await session.query('ROLLBACK').catch(() => undefined);
    if (mysqlTableCreated && input.dropSql) {
      try {
        await session.query(input.dropSql);
      } catch (cleanupErr) {
        throw new Error(`${errorMessage(err)} Cleanup also failed: ${errorMessage(cleanupErr)}`);
      }
    }
    throw err;
  }
}
