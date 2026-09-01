import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// The validation module ships as a plain webview script with a CommonJS escape
// hatch; load it the way the webview cannot.
const requireJs = createRequire(__filename);
const { validateDataSourceForm, deriveDataSourceName } = requireJs(
  join(__dirname, '..', '..', 'media', 'validation.js'),
) as {
  validateDataSourceForm: (form: any, opts?: { forSave?: boolean }) => { field: string; message: string }[];
  deriveDataSourceName: (form: any) => string;
};

const validPg = {
  name: 'acme@localhost',
  driver: 'postgres',
  host: 'localhost',
  port: 5432,
  user: 'api',
  auth: 'userPassword',
  ssh: { enabled: false },
};

function fields(form: any, opts?: { forSave?: boolean }): string[] {
  return validateDataSourceForm(form, opts).map((e) => e.field);
}

test('a filled-in network form passes', () => {
  assert.deepEqual(fields(validPg, { forSave: true }), []);
});

test('an empty form fails on every required field', () => {
  const errors = fields(
    { name: '', driver: 'postgres', host: '', port: undefined, user: '', auth: 'userPassword' },
    { forSave: true },
  );
  assert.deepEqual(errors, ['name', 'host', 'port', 'user']);
});

test('name is only required when saving', () => {
  assert.deepEqual(fields({ ...validPg, name: '' }), []);
  assert.deepEqual(fields({ ...validPg, name: '  ' }, { forSave: true }), ['name']);
});

test('user is not required for no-auth', () => {
  assert.deepEqual(fields({ ...validPg, user: '', auth: 'none' }), []);
  assert.deepEqual(fields({ ...validPg, user: '', auth: 'pgpass' }), ['user']);
});

test('port bounds and non-numeric ports', () => {
  assert.deepEqual(fields({ ...validPg, port: 0 }), ['port']);
  assert.deepEqual(fields({ ...validPg, port: 65536 }), ['port']);
  assert.deepEqual(fields({ ...validPg, port: NaN }), ['port']);
  assert.deepEqual(fields({ ...validPg, port: 65535 }), []);
});

test('sqlite requires only the file (and a name to save)', () => {
  assert.deepEqual(fields({ driver: 'sqlite', file: '' }), ['file']);
  assert.deepEqual(fields({ driver: 'sqlite', file: '/tmp/x.db' }), []);
  assert.deepEqual(fields({ name: '', driver: 'sqlite', file: '/tmp/x.db' }, { forSave: true }), ['name']);
});

test('ssh fields are validated only when the tunnel is enabled', () => {
  assert.deepEqual(fields({ ...validPg, ssh: { enabled: false, host: '', user: '' } }), []);
  assert.deepEqual(
    fields({ ...validPg, ssh: { enabled: true, host: '', user: '', port: 22, auth: 'password' } }),
    ['sshHost', 'sshUser'],
  );
  assert.deepEqual(
    fields({ ...validPg, ssh: { enabled: true, host: 'bastion', user: 'ops', port: 22, auth: 'keyFile', keyFile: '' } }),
    ['sshKeyFile'],
  );
  assert.deepEqual(
    fields({ ...validPg, ssh: { enabled: true, host: 'bastion', user: 'ops', port: NaN, auth: 'password' } }),
    ['sshPort'],
  );
});

test('derived names follow database@host and the sqlite file name', () => {
  assert.equal(deriveDataSourceName({ driver: 'postgres', database: 'acme', host: 'localhost' }), 'acme@localhost');
  assert.equal(deriveDataSourceName({ driver: 'postgres', database: '', host: 'db.example.com' }), 'db.example.com');
  assert.equal(deriveDataSourceName({ driver: 'postgres', database: 'acme', host: '' }), 'acme');
  assert.equal(deriveDataSourceName({ driver: 'mysql', database: '', host: '' }), '');
  assert.equal(deriveDataSourceName({ driver: 'sqlite', file: '/Users/x/data/app.db' }), 'app.db');
  assert.equal(deriveDataSourceName({ driver: 'sqlite', file: '' }), '');
});
