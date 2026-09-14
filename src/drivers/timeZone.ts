import type { DataSourceConfig } from '../core/types';

/** Stored value meaning "leave the server's own time zone alone". */
export const SERVER_TIME_ZONE = 'server';

/** The machine's IANA zone, as the extension host sees it. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The canonical spelling of a zone the runtime knows (`europe/london` → `Europe/London`), undefined otherwise. */
export function canonicalTimeZone(name: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Zone names for the dialog's list: UTC first, then everything the runtime knows. */
export function timeZoneNames(): string[] {
  const names: string[] = Intl.supportedValuesOf('timeZone');
  return ['UTC', ...names.filter((name) => name !== 'UTC')];
}

/**
 * Normalize a time zone as typed in the dialog or written in settings.json.
 * Undefined means Local (the default), `server` keeps the server's setting,
 * anything else is the canonical zone name. A name the runtime does not know
 * throws, unless `lenient`, which keeps the text so the connect error names it.
 */
export function normalizeTimeZone(raw: unknown, opts?: { lenient?: boolean }): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text || text.toLowerCase() === 'local') return undefined;
  if (text.toLowerCase() === SERVER_TIME_ZONE) return SERVER_TIME_ZONE;
  const canonical = canonicalTimeZone(text);
  if (canonical) return canonical;
  if (opts?.lenient) return text;
  throw new Error(`Unknown time zone "${text}". Use Local, Server, or a zone name such as Europe/London.`);
}

/** The zone a session is set to at connect, or undefined to leave the server's setting. */
export function sessionTimeZone(config: Pick<DataSourceConfig, 'driver' | 'timeZone'>): string | undefined {
  if (config.driver === 'sqlite') return undefined;
  if (config.timeZone === SERVER_TIME_ZONE) return undefined;
  return config.timeZone ?? localTimeZone();
}

/**
 * The zone's UTC offset at `at`, spelled the way MySQL takes it (`+05:30`).
 * Stands in for a named zone on servers without time zone tables.
 */
export function utcOffsetOf(zone: string, at: Date = new Date()): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name ?? '');
  if (!match) return '+00:00';
  return `${match[1]}${match[2]!.padStart(2, '0')}:${match[3] ?? '00'}`;
}
