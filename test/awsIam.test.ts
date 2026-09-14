import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { friendlyAwsError, inferRdsRegion, rdsTokenRequest, resolveAwsCli, tokenArgs } from '../src/data/awsIam';
import type { DataSourceConfig } from '../src/core/types';

/** Every endpoint shape RDS hands out, and the names that must not pass for one. */
const HOSTS: [string, string | undefined][] = [
  ['acme.c1x9z2m.us-east-1.rds.amazonaws.com', 'us-east-1'],
  ['acme.cluster-c1x9z2m.eu-west-2.rds.amazonaws.com', 'eu-west-2'],
  ['acme.cluster-ro-c1x9z2m.ap-southeast-4.rds.amazonaws.com', 'ap-southeast-4'],
  ['acme-proxy.proxy-c1x9z2m.us-gov-west-1.rds.amazonaws.com', 'us-gov-west-1'],
  ['acme.c1x9z2m.cn-north-1.rds.amazonaws.com.cn', 'cn-north-1'],
  ['acme.c1x9z2m.ca-central-1.rds.amazonaws.com', 'ca-central-1'],
  ['ACME.C1X9Z2M.US-EAST-1.RDS.AMAZONAWS.COM', 'us-east-1'],
  ['  acme.c1x9z2m.us-east-1.rds.amazonaws.com  ', 'us-east-1'],
  ['db.internal.example.com', undefined],
  ['10.0.0.12', undefined],
  ['localhost', undefined],
  ['', undefined],
  ['acme.c1x9z2m.us-east-1.rds.amazonaws.com.example', undefined],
  ['rds.amazonaws.com', undefined],
  ['acme.rds.amazonaws.com', undefined],
];

const config = (over: Partial<DataSourceConfig> = {}): DataSourceConfig => ({
  id: 'x',
  name: 'x',
  driver: 'postgres',
  color: 'none',
  readOnly: false,
  autoSync: true,
  auth: 'awsIam',
  host: 'acme.c1x9z2m.us-east-1.rds.amazonaws.com',
  user: 'app_reader',
  ...over,
});

test('the region comes off instance, cluster, proxy and .com.cn endpoints and nothing else', () => {
  for (const [host, region] of HOSTS) assert.equal(inferRdsRegion(host), region, host);
  assert.equal(inferRdsRegion(undefined), undefined);
});

test('the dialog uses the same inference as the driver', () => {
  const requireJs = createRequire(__filename);
  const validation = requireJs(join(__dirname, '..', '..', 'media', 'validation.js')) as {
    inferRdsRegion: (host: string) => string | undefined;
  };
  for (const [host, region] of HOSTS) assert.equal(validation.inferRdsRegion(host), region, host);
});

test('the token request takes the typed region over the inferred one and refuses to guess', () => {
  assert.deepEqual(rdsTokenRequest(config(), 5432), {
    host: 'acme.c1x9z2m.us-east-1.rds.amazonaws.com',
    port: 5432,
    user: 'app_reader',
    region: 'us-east-1',
    profile: undefined,
  });
  assert.equal(rdsTokenRequest(config({ aws: { region: 'eu-west-1' } }), 5432).region, 'eu-west-1');
  assert.equal(rdsTokenRequest(config({ port: 6432, aws: { profile: 'staging' } }), 5432).port, 6432);
  assert.equal(rdsTokenRequest(config({ aws: { profile: 'staging' } }), 5432).profile, 'staging');
  assert.throws(
    () => rdsTokenRequest(config({ host: 'db.internal.example.com' }), 5432),
    /AWS region could not be inferred from the host db.internal.example.com/,
  );
  assert.equal(rdsTokenRequest(config({ host: 'db.internal.example.com', aws: { region: 'us-east-1' } }), 5432).host, 'db.internal.example.com');
});

test('argv is exact, one value per option, with the profile only when set', () => {
  const req = { host: 'acme.c1x9z2m.us-east-1.rds.amazonaws.com', port: 5432, user: 'app_reader', region: 'us-east-1' };
  assert.deepEqual(tokenArgs(req), [
    'rds',
    'generate-db-auth-token',
    '--hostname',
    'acme.c1x9z2m.us-east-1.rds.amazonaws.com',
    '--port',
    '5432',
    '--region',
    'us-east-1',
    '--username',
    'app_reader',
  ]);
  assert.deepEqual(tokenArgs({ ...req, profile: 'acme-staging' }).slice(-2), ['--profile', 'acme-staging']);
  // a hostile value stays a value: it follows its own option and is never shell-parsed
  assert.deepEqual(tokenArgs({ ...req, user: '--profile' }).slice(8), ['--username', '--profile']);
});

test('the CLI path: the setting, then a known install location, then PATH', () => {
  assert.equal(resolveAwsCli('/custom/aws', () => true), '/custom/aws');
  assert.equal(resolveAwsCli('  ', (p) => p === '/usr/local/bin/aws'), '/usr/local/bin/aws');
  assert.equal(resolveAwsCli(undefined, (p) => p === '/opt/homebrew/bin/aws'), '/opt/homebrew/bin/aws');
  assert.equal(resolveAwsCli(undefined, () => false), 'aws');
});

test('CLI failures become the next action', () => {
  const req = { host: 'h', port: 5432, user: 'u', region: 'us-east-1', profile: 'acme-staging' };
  const errorFor = (over: Record<string, unknown>) => friendlyAwsError(Object.assign(new Error('x'), over), req).message;

  assert.equal(errorFor({ code: 'ENOENT' }), 'The AWS CLI was not found. Install it, or set tablecloth.aws.cliPath to where it is.');
  assert.match(errorFor({ killed: true, signal: 'SIGTERM' }), /did not answer within 20 s.*sign in from a terminal first/);
  // the strings the AWS CLI v2 prints today
  assert.equal(
    errorFor({ stderr: '\nError when retrieving token from sso: Token has expired and refresh failed\n' }),
    'The AWS SSO session for profile acme-staging has expired. Run: aws sso login --profile acme-staging',
  );
  assert.equal(
    errorFor({
      stderr:
        'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
    }),
    'The AWS SSO session for profile acme-staging has expired. Run: aws sso login --profile acme-staging',
  );
  assert.equal(
    errorFor({ stderr: 'Error loading SSO Token: Token for acme-sso does not exist' }),
    'No AWS SSO session for profile acme-staging. Run: aws sso login --profile acme-staging',
  );
  assert.equal(
    errorFor({ stderr: '\nThe config profile (acme-staging) could not be found\n' }),
    'The config profile (acme-staging) could not be found. Check the AWS profile on the data source against ~/.aws/config.',
  );
  assert.equal(
    errorFor({ stderr: 'Unable to locate credentials. You can configure credentials by running "aws configure".' }),
    'No AWS credentials for profile acme-staging. Check ~/.aws/config, or run: aws sso login --profile acme-staging',
  );
  assert.match(errorFor({ stderr: 'EOF when reading a line' }), /asked for input.*Sign in from a terminal first/);
  // anything else keeps the CLI's own words, or the error's when it printed none
  assert.equal(errorFor({ stderr: 'Something new from a future CLI\n' }), 'Something new from a future CLI');
  assert.equal(errorFor({ stderr: '' }), 'x');
  assert.equal(friendlyAwsError('plain string', req).message, 'plain string');
});

test('a profile named like an SSO one still gets the not-found hint, and the SSO hint when it has expired', () => {
  const req = { host: 'h', port: 5432, user: 'u', region: 'us-east-1', profile: 'acme-sso' };
  const errorFor = (stderr: string) => friendlyAwsError(Object.assign(new Error('x'), { stderr }), req).message;

  assert.equal(
    errorFor('\nThe config profile (acme-sso) could not be found\n'),
    'The config profile (acme-sso) could not be found. Check the AWS profile on the data source against ~/.aws/config.',
  );
  assert.equal(
    errorFor('Unable to locate credentials. You can configure credentials by running "aws configure".'),
    'No AWS credentials for profile acme-sso. Check ~/.aws/config, or run: aws sso login --profile acme-sso',
  );
  assert.equal(
    errorFor('Error when retrieving token from sso: Token has expired and refresh failed'),
    'The AWS SSO session for profile acme-sso has expired. Run: aws sso login --profile acme-sso',
  );
});

test('without a profile the sign-in hint falls back to AWS_PROFILE, then to a bare aws sso login', () => {
  const req = { host: 'h', port: 5432, user: 'u', region: 'us-east-1' };
  const stderr = 'Error when retrieving token from sso: Token has expired and refresh failed';
  const saved = process.env.AWS_PROFILE;
  try {
    process.env.AWS_PROFILE = 'from-env';
    assert.equal(
      friendlyAwsError(Object.assign(new Error('x'), { stderr }), req).message,
      'The AWS SSO session for profile from-env has expired. Run: aws sso login --profile from-env',
    );
    delete process.env.AWS_PROFILE;
    assert.equal(
      friendlyAwsError(Object.assign(new Error('x'), { stderr }), req).message,
      'The AWS SSO session has expired. Run: aws sso login',
    );
  } finally {
    if (saved === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = saved;
  }
});
