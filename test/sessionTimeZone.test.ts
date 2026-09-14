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
  const applied = await applyPostgresTimeZone(client, "Amer'ica/Jamaica");
  assert.deepEqual(applied, { timeZone: "Amer'ica/Jamaica" });
  assert.deepEqual(client.sent, ["SET TIME ZONE 'Amer''ica/Jamaica'"]);
});

test('PostgreSQL keeps the server zone and says so when it lacks the implicit Local zone', async () => {
  const client = stub({ pattern: /SET TIME ZONE/, message: 'invalid value for parameter "TimeZone": "Europe/Kyiv"' });
  const applied = await applyPostgresTimeZone(client, 'Europe/Kyiv', true);
  assert.equal(applied.timeZone, undefined);
  assert.equal(
    applied.note,
    'The server does not know this machine\'s time zone "Europe/Kyiv" (invalid value for parameter "TimeZone": "Europe/Kyiv"), ' +
      "so times are shown in the server's zone. Pick a zone, or Server, on the data source's Options tab.",
  );
  assert.equal(client.sent.length, 1);
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
  assert.match(
    applied.note ?? '',
    /^MariaDB does not know the time zone Asia\/Kolkata \(no time zone tables, or older ones\), so it is applied as the fixed offset \+05:30;/,
  );
  assert.match(applied.note ?? '', /Load or update the tables \(mysql_tzinfo_to_sql\)/);
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

test('MySQL keeps the server zone and says so when neither it nor the runtime knows the implicit Local zone', async () => {
  const connection = stub({ pattern: /SET time_zone/, code: 'ER_UNKNOWN_TIME_ZONE', message: "Unknown or incorrect time zone: 'Etc/Unknown'" });
  const applied = await applyMySqlTimeZone(connection, 'Etc/Unknown', 'MariaDB', true);
  assert.equal(applied.timeZone, undefined);
  assert.equal(
    applied.note,
    "MariaDB does not know the time zone Etc/Unknown (Unknown or incorrect time zone: 'Etc/Unknown'), " +
      "so times are shown in the server's zone. Pick a zone, or Server, on the data source's Options tab.",
  );
  assert.deepEqual(connection.sent, ["SET time_zone = 'Etc/Unknown'"]);
});

test('MySQL keeps the server zone and says so when it also rejects the implicit Local offset', async () => {
  const connection = stub({ pattern: /SET time_zone/, code: 'ER_UNKNOWN_TIME_ZONE', message: 'Unknown or incorrect time zone' });
  const applied = await applyMySqlTimeZone(connection, 'Asia/Kolkata', 'MySQL', true);
  assert.equal(applied.timeZone, undefined);
  assert.equal(
    applied.note,
    'MySQL does not know the time zone Asia/Kolkata and rejects the offset +05:30 (Unknown or incorrect time zone), ' +
      "so times are shown in the server's zone. Pick a zone, or Server, on the data source's Options tab.",
  );
  assert.deepEqual(connection.sent, ["SET time_zone = 'Asia/Kolkata'", "SET time_zone = '+05:30'"]);
});

test('MySQL names the zone and the Options tab when it rejects a chosen zone and its offset', async () => {
  const connection = stub({ pattern: /SET time_zone/, code: 'ER_UNKNOWN_TIME_ZONE', message: 'Unknown or incorrect time zone' });
  await assert.rejects(
    applyMySqlTimeZone(connection, 'Asia/Kolkata', 'MySQL'),
    /^Error: The server does not know the time zone "Asia\/Kolkata" \(Unknown or incorrect time zone\)\. Pick another zone, or Server, on the data source's Options tab\.$/,
  );
  assert.equal(connection.sent.length, 2);
});

test('MySQL passes any other failure through untouched', async () => {
  const connection = stub({ pattern: /SET time_zone/, code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied' });
  await assert.rejects(applyMySqlTimeZone(connection, 'Asia/Tokyo', 'MySQL'), /Access denied/);
  assert.equal(connection.sent.length, 1);
});
