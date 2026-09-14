import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAwsProfiles, parseAwsConfig } from '../src/data/awsProfiles';

const CONFIG = `# Amazon Web Services Config File used by AWS CLI, SDKs, and tools
[default]
region = us-west-2
output = json

[sso-session acme-sso]
sso_region = us-east-1
sso_start_url = https://d-1234567890.awsapps.com/start

[profile acme-dev]
sso_session = acme-sso
sso_account_id = 111111111111
sso_role_name = Engineer
region = us-east-1

[ profile acme-legacy ]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1
region=eu-west-1

[profile acme-role]
role_arn = arn:aws:iam::222222222222:role/local-dev
source_profile = acme-dev
region = us-east-1

[profile keys-in-config]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[services s3-local]
s3 =
  endpoint_url = http://localhost:9000

[profile bare]
`;

const CREDENTIALS = `[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

; a second set of static keys
[ci]
aws_access_key_id = AKIAI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY
region = ap-southeast-2
`;

test('the config file yields names, regions and how each profile signs in', () => {
  assert.deepEqual(parseAwsConfig(CONFIG, 'config'), [
    { name: 'default', kind: 'other', region: 'us-west-2' },
    { name: 'acme-dev', kind: 'sso', region: 'us-east-1' },
    { name: 'acme-legacy', kind: 'sso', region: 'eu-west-1' },
    { name: 'acme-role', kind: 'other', region: 'us-east-1' },
    { name: 'keys-in-config', kind: 'keys' },
    { name: 'bare', kind: 'other' },
  ]);
});

test('the credentials file contributes names only; its values are never read', () => {
  assert.deepEqual(parseAwsConfig(CREDENTIALS, 'credentials'), [
    { name: 'default', kind: 'keys' },
    { name: 'ci', kind: 'keys' },
  ]);
});

test('an empty or odd file yields an empty list rather than an error', () => {
  assert.deepEqual(parseAwsConfig('', 'config'), []);
  assert.deepEqual(parseAwsConfig('not an ini file at all\n= nope\n[unclosed', 'config'), []);
  assert.deepEqual(parseAwsConfig('region = us-east-1\n', 'config'), [], 'a key before any section belongs to nothing');
});

test('both files are read from their environment overrides, config entries winning on a shared name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablecloth-aws-'));
  writeFileSync(join(dir, 'config'), CONFIG);
  writeFileSync(join(dir, 'credentials'), CREDENTIALS);
  const saved = { config: process.env.AWS_CONFIG_FILE, credentials: process.env.AWS_SHARED_CREDENTIALS_FILE };
  try {
    process.env.AWS_CONFIG_FILE = join(dir, 'config');
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'credentials');
    const names = (await listAwsProfiles()).map((p) => `${p.name}:${p.kind}`);
    assert.deepEqual(names, [
      'default:other',
      'acme-dev:sso',
      'acme-legacy:sso',
      'acme-role:other',
      'keys-in-config:keys',
      'bare:other',
      'ci:keys',
    ]);

    process.env.AWS_CONFIG_FILE = join(dir, 'missing-config');
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'missing-credentials');
    assert.deepEqual(await listAwsProfiles(), [], 'missing files contribute nothing');
  } finally {
    for (const [key, value] of [
      ['AWS_CONFIG_FILE', saved.config],
      ['AWS_SHARED_CREDENTIALS_FILE', saved.credentials],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
