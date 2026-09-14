import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTimeZone as applyPostgresTimeZone } from '../src/drivers/postgres';
import { applyTimeZone as applyMySqlTimeZone } from '../src/drivers/mysql';

/** A connection that records statements and fails the ones `refuse` matches. */
function stub(refuse?: { pattern: RegExp; code?: string; message: string }) {
  const sent: string[] = [];
  const query = async (sql: string | { text: string }, values?: unknown[]) => {
    let text = typeof sql === 'string' ? sql : sql.text;
    // mysql2's client-side placeholders, enough for a SET
    for (const value of values ?? []) text = text.replace('?', `'${String(value)}'`);
    sent.push(text);
    if (refuse && refuse.pattern.test(text)) {
      throw Object.assign(new Error(refuse.message), refuse.code ? { code: refuse.code } : {});
    }
    return [[], []] as any;
  };
  return { sent, query: query as any };
}

test('PostgreSQL sets the session zone with one quoted SET', async () => {
  const client = stub();
  await applyPostgresTimeZone(client, "Amer'ica/Jamaica");
  assert.deepEqual(client.sent, ["SET TIME ZONE 'Amer''ica/Jamaica'"]);
});

test('PostgreSQL names the zone and the Options tab when the server refuses it', async () => {
  const client = stub({ pattern: /SET TIME ZONE/, message: 'invalid value for parameter "TimeZone": "Mars/Olympus_Mons"' });
  await assert.rejects(
    applyPostgresTimeZone(client, 'Mars/Olympus_Mons'),
    /does not know the time zone "Mars\/Olympus_Mons" \(invalid value for parameter "TimeZone": "Mars\/Olympus_Mons"\)\. Pick another zone, or Server, on the data source's Options tab\./,
  );
});

test('MySQL takes a named zone when the server has time zone tables', async () => {
  const connection = stub();
  const applied = await applyMySqlTimeZone(connection, 'Asia/Tokyo', 'MySQL');
  assert.deepEqual(applied, { timeZone: 'Asia/Tokyo' });
  assert.deepEqual(connection.sent, ["SET time_zone = 'Asia/Tokyo'"]);
});

test('MySQL without time zone tables falls back to the offset and says so once', async () => {
  const connection = stub({ pattern: /'Asia\/Kolkata'/, code: 'ER_UNKNOWN_TIME_ZONE', message: "Unknown or incorrect time zone: 'Asia/Kolkata'" });
  const applied = await applyMySqlTimeZone(connection, 'Asia/Kolkata', 'MariaDB');
  assert.equal(applied.timeZone, '+05:30');
  assert.match(applied.note ?? '', /^MariaDB has no time zone tables, so Asia\/Kolkata is applied as the fixed offset \+05:30;/);
  assert.match(applied.note ?? '', /mysql_tzinfo_to_sql/);
  assert.deepEqual(connection.sent, ["SET time_zone = 'Asia/Kolkata'", "SET time_zone = '+05:30'"]);
});

test('MySQL names the zone and the Options tab when neither the server nor the runtime knows it', async () => {
  const connection = stub({ pattern: /SET time_zone/, code: 'ER_UNKNOWN_TIME_ZONE', message: "Unknown or incorrect time zone: 'Mars/Olympus_Mons'" });
  await assert.rejects(
    applyMySqlTimeZone(connection, 'Mars/Olympus_Mons', 'MySQL'),
    /^Error: The server does not know the time zone "Mars\/Olympus_Mons" \(Unknown or incorrect time zone: 'Mars\/Olympus_Mons'\)\. Pick another zone, or Server, on the data source's Options tab\.$/,
  );
  assert.equal(connection.sent.length, 1);
});

test('MySQL passes any other failure through untouched', async () => {
  const connection = stub({ pattern: /SET time_zone/, code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied' });
  await assert.rejects(applyMySqlTimeZone(connection, 'Asia/Tokyo', 'MySQL'), /Access denied/);
  assert.equal(connection.sent.length, 1);
});
