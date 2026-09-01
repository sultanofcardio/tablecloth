import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PgPassQuery {
  host: string;
  port: number;
  database: string;
  user: string;
}

/**
 * Parse one ~/.pgpass line into its five fields, honoring backslash escapes
 * for ':' and '\'. Returns undefined for comments and malformed lines.
 */
export function parsePgPassLine(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && i + 1 < trimmed.length) {
      current += trimmed[i + 1];
      i++;
    } else if (ch === ':') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.length === 5 ? fields : undefined;
}

export function matchPgPass(content: string, query: PgPassQuery): string | undefined {
  const matches = (pattern: string, value: string) => pattern === '*' || pattern === value;
  for (const line of content.split('\n')) {
    const fields = parsePgPassLine(line);
    if (!fields) continue;
    const [host, port, database, user, password] = fields as [string, string, string, string, string];
    if (
      matches(host, query.host) &&
      matches(port, String(query.port)) &&
      matches(database, query.database) &&
      matches(user, query.user)
    ) {
      return password;
    }
  }
  return undefined;
}

/** Look up a password in the pgpass file (PGPASSFILE or ~/.pgpass). */
export function lookupPgPass(query: PgPassQuery): string | undefined {
  const file = process.env.PGPASSFILE ?? join(homedir(), '.pgpass');
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return matchPgPass(content, query);
}
