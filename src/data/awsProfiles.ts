import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AwsProfile {
  name: string;
  /** "sso" signs in through IAM Identity Center; "keys" holds static credentials; "other" is a role or a credential process. */
  kind: 'sso' | 'keys' | 'other';
  region?: string;
}

type Source = 'config' | 'credentials';

/**
 * The profile names in one AWS config-format file, plus, from the config file
 * only, each profile's region and how it signs in. The credentials file
 * contributes names alone: its values are never looked at, let alone kept.
 */
export function parseAwsConfig(text: string, source: Source): AwsProfile[] {
  const out = new Map<string, AwsProfile>();
  let current: AwsProfile | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*(?:profile\s+)?([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      const name = header[1]!;
      // [sso-session x] and [services x] are not profiles
      if (/^(sso-session|services)\s/.test(name)) {
        current = undefined;
        continue;
      }
      current = out.get(name) ?? { name, kind: source === 'credentials' ? 'keys' : 'other' };
      out.set(name, current);
      continue;
    }
    if (!current || source === 'credentials') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'region' && value) current.region = value;
    if (key === 'sso_session' || key === 'sso_start_url') current.kind = 'sso';
    if (key === 'aws_access_key_id' && current.kind === 'other') current.kind = 'keys';
  }
  return [...out.values()];
}

/**
 * Config first, then credentials. A name in both keeps the config entry, its
 * region and its sign-in kind; only when config says nothing about how the
 * profile signs in does the credentials file's presence mark it as keys.
 * Missing or unreadable files contribute nothing, so a machine without the
 * CLI set up gets an empty list rather than an error.
 */
export async function listAwsProfiles(): Promise<AwsProfile[]> {
  const home = join(homedir(), '.aws');
  const files: [string, Source][] = [
    [process.env.AWS_CONFIG_FILE || join(home, 'config'), 'config'],
    [process.env.AWS_SHARED_CREDENTIALS_FILE || join(home, 'credentials'), 'credentials'],
  ];
  const seen = new Map<string, AwsProfile>();
  for (const [path, source] of files) {
    const text = await readFile(path, 'utf8').catch(() => '');
    for (const profile of parseAwsConfig(text, source)) {
      const existing = seen.get(profile.name);
      if (!existing) seen.set(profile.name, profile);
      else if (existing.kind === 'other' && profile.kind === 'keys') existing.kind = 'keys';
    }
  }
  return [...seen.values()];
}
