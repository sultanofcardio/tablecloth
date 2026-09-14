import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { DataSourceConfig } from '../core/types';

const run = promisify(execFile);

/** How long the CLI gets to sign a token. Signing is local, so a healthy CLI answers in well under a second. */
const CLI_TIMEOUT_MS = 20_000;

/**
 * "us-east-1" from acme.c1x9z2m.us-east-1.rds.amazonaws.com: instance, cluster,
 * reader and proxy endpoints, plus the .com.cn partition. Undefined for a
 * CNAME, an IP address or anything else. media/validation.js carries the same
 * expression for the dialog; a test asserts the two agree.
 */
export function inferRdsRegion(host: string | undefined): string | undefined {
  const m = /\.([a-z]{2}(?:-gov)?-[a-z]+-\d+)\.rds\.amazonaws\.com(?:\.cn)?$/i.exec((host ?? '').trim());
  return m?.[1]?.toLowerCase();
}

export interface RdsTokenRequest {
  /** The RDS endpoint the token is signed for: the data source host, never a tunnel's local end. */
  host: string;
  port: number;
  /** The database role, the one granted rds_iam (PostgreSQL) or created with AWSAuthenticationPlugin (MySQL). */
  user: string;
  region: string;
  /** Absent means the default credential chain: AWS_PROFILE, environment variables, an instance role. */
  profile?: string;
}

/** The request for one data source, or a clear error when the region is unknowable. */
export function rdsTokenRequest(config: DataSourceConfig, defaultPort: number): RdsTokenRequest {
  const host = config.host ?? 'localhost';
  const region = config.aws?.region ?? inferRdsRegion(host);
  if (!region) {
    throw new Error(`AWS region could not be inferred from the host ${host}. Set AWS region on the data source.`);
  }
  return { host, port: config.port ?? defaultPort, user: config.user ?? '', region, profile: config.aws?.profile };
}

/**
 * argv for `aws rds generate-db-auth-token`. Pure, so the unit test can check it
 * exactly. Every value follows its own option, so a host or user name can never
 * be read as a flag, and execFile takes the array without a shell.
 */
export function tokenArgs(req: RdsTokenRequest): string[] {
  const args = [
    'rds',
    'generate-db-auth-token',
    '--hostname',
    req.host,
    '--port',
    String(req.port),
    '--region',
    req.region,
    '--username',
    req.user,
  ];
  return req.profile ? [...args, '--profile', req.profile] : args;
}

/** Where the installers put the CLI. The extension host's PATH on macOS often lacks Homebrew. */
const KNOWN_CLI_PATHS = [
  '/opt/homebrew/bin/aws',
  '/usr/local/bin/aws',
  '/usr/local/aws-cli/aws',
  'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
];

/**
 * Reads the tablecloth.aws.cliPath setting. The extension wires this at
 * activation; this module never imports vscode, so the unit tests load it
 * under plain node the way they load pgpass.ts.
 */
let configuredCliPath: () => string | undefined = () => undefined;

export function setAwsCliPathSource(read: () => string | undefined): void {
  configuredCliPath = read;
}

/** The setting wins, then the usual install locations, then whatever PATH resolves. */
export function resolveAwsCli(configured = configuredCliPath(), exists: (path: string) => boolean = existsSync): string {
  const setting = configured?.trim();
  if (setting) return setting;
  return KNOWN_CLI_PATHS.find((p) => exists(p)) ?? 'aws';
}

/**
 * A fresh token, valid for fifteen minutes and only needed for the handshake.
 * Signing is local: it succeeds with the VPN down, and the connect step then
 * reports the real failure. Nothing is cached, so every connect mints again.
 */
export async function mintRdsAuthToken(req: RdsTokenRequest): Promise<string> {
  let stdout: string;
  try {
    const pending = run(resolveAwsCli(), tokenArgs(req), {
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, AWS_PAGER: '' },
      windowsHide: true,
    });
    // No terminal here: a profile that prompts (an MFA code) reads EOF and fails
    // at once instead of waiting out the timeout.
    pending.child.stdin?.end();
    ({ stdout } = await pending);
  } catch (err) {
    throw friendlyAwsError(err, req);
  }
  const token = stdout.trim();
  if (!token) throw new Error('The AWS CLI printed no token.');
  return token;
}

/**
 * The CLI's failure as the next action. Its own text is kept whenever it is
 * not recognised, so the message stays searchable.
 */
export function friendlyAwsError(err: unknown, req: RdsTokenRequest): Error {
  const e = (err ?? {}) as { code?: unknown; killed?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  const profile = req.profile ?? process.env.AWS_PROFILE;
  const forProfile = profile ? ` for profile ${profile}` : '';
  const login = `aws sso login${profile ? ` --profile ${profile}` : ''}`;
  if (e.code === 'ENOENT') {
    return new Error('The AWS CLI was not found. Install it, or set tablecloth.aws.cliPath to where it is.');
  }
  if (e.killed) {
    return new Error(
      `The AWS CLI did not answer within ${CLI_TIMEOUT_MS / 1000} s. ` +
        'A profile that prompts (for an MFA code, say) cannot answer here; sign in from a terminal first.',
    );
  }
  if (/EOF when reading|Enter MFA code/i.test(stderr)) {
    return new Error('The AWS CLI asked for input, which it cannot get here. Sign in from a terminal first.');
  }
  if (/config profile \(.*\) could not be found/i.test(stderr)) {
    return new Error(`${stderr}. Check the AWS profile on the data source against ~/.aws/config.`);
  }
  if (/unable to locate credentials/i.test(stderr)) {
    return new Error(`No AWS credentials${forProfile}. Check ~/.aws/config, or run: ${login}`);
  }
  if (/\bsso\b/i.test(stderr) && /does not exist/i.test(stderr)) {
    return new Error(`No AWS SSO session${forProfile}. Run: ${login}`);
  }
  if (/\bsso\b/i.test(stderr) || /token has expired/i.test(stderr)) {
    return new Error(`The AWS SSO session${forProfile} has expired. Run: ${login}`);
  }
  return new Error(stderr || (typeof e.message === 'string' && e.message) || String(err));
}
