/**
 * Words that cannot be used bare as an identifier in at least one supported
 * dialect: the PostgreSQL reserved keywords, the MySQL 8 reserved words, and
 * the SQLite keyword list. Generated SQL quotes any name found here, whatever
 * the dialect: a quoted name always resolves, while a bare reserved word is a
 * syntax error. Formatting and completion keep using the smaller SQL_KEYWORDS.
 */
export const SQL_RESERVED_WORDS: ReadonlySet<string> = new Set([
  // PostgreSQL
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization', 'binary', 'both',
  'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently', 'constraint', 'create', 'cross',
  'current_catalog', 'current_date', 'current_role', 'current_schema', 'current_time', 'current_timestamp',
  'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch',
  'for', 'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner',
  'intersect', 'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
  'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer', 'overlaps',
  'placing', 'primary', 'references', 'returning', 'right', 'select', 'session_user', 'similar', 'some', 'symmetric',
  'system_user', 'table', 'tablesample', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using',
  'variadic', 'verbose', 'when', 'where', 'window', 'with',
  // MySQL 8
  'accessible', 'add', 'alter', 'asensitive', 'before', 'between', 'bigint', 'blob', 'by', 'call', 'cascade',
  'change', 'char', 'character', 'condition', 'continue', 'convert', 'cube', 'cume_dist', 'cursor', 'database',
  'databases', 'day_hour', 'day_microsecond', 'day_minute', 'day_second', 'dec', 'decimal', 'declare', 'delayed',
  'delete', 'dense_rank', 'describe', 'deterministic', 'distinctrow', 'div', 'double', 'drop', 'dual', 'each',
  'elseif', 'empty', 'enclosed', 'escaped', 'exists', 'exit', 'explain', 'first_value', 'float', 'float4', 'float8',
  'force', 'fulltext', 'function', 'generated', 'get', 'grouping', 'groups', 'high_priority', 'hour_microsecond',
  'hour_minute', 'hour_second', 'if', 'ignore', 'index', 'infile', 'inout', 'insensitive', 'insert', 'int', 'int1',
  'int2', 'int3', 'int4', 'int8', 'integer', 'interval', 'io_after_gtids', 'io_before_gtids', 'iterate',
  'json_table', 'key', 'keys', 'kill', 'lag', 'last_value', 'lead', 'leave', 'linear', 'lines', 'load', 'lock',
  'long', 'longblob', 'longtext', 'loop', 'low_priority', 'master_bind', 'master_ssl_verify_server_cert', 'match',
  'maxvalue', 'mediumblob', 'mediumint', 'mediumtext', 'middleint', 'minute_microsecond', 'minute_second', 'mod',
  'modifies', 'no_write_to_binlog', 'nth_value', 'ntile', 'numeric', 'of', 'optimize', 'optimizer_costs', 'option',
  'optionally', 'out', 'outfile', 'over', 'partition', 'percent_rank', 'precision', 'procedure', 'purge', 'range',
  'rank', 'read', 'reads', 'read_write', 'real', 'recursive', 'regexp', 'release', 'rename', 'repeat', 'replace',
  'require', 'resignal', 'restrict', 'return', 'revoke', 'rlike', 'row', 'rows', 'row_number', 'schema', 'schemas',
  'second_microsecond', 'sensitive', 'separator', 'set', 'show', 'signal', 'smallint', 'spatial', 'specific', 'sql',
  'sqlexception', 'sqlstate', 'sqlwarning', 'sql_big_result', 'sql_calc_found_rows', 'sql_small_result', 'ssl',
  'starting', 'stored', 'straight_join', 'system', 'terminated', 'tinyblob', 'tinyint', 'tinytext', 'trigger',
  'undo', 'unlock', 'unsigned', 'update', 'usage', 'use', 'utc_date', 'utc_time', 'utc_timestamp', 'values',
  'varbinary', 'varchar', 'varcharacter', 'varying', 'virtual', 'while', 'write', 'xor', 'year_month', 'zerofill',
  // SQLite
  'abort', 'action', 'after', 'always', 'attach', 'autoincrement', 'begin', 'commit', 'conflict', 'current',
  'deferred', 'detach', 'escape', 'exclude', 'exclusive', 'fail', 'filter', 'first', 'following', 'glob',
  'immediate', 'indexed', 'instead', 'last', 'materialized', 'no', 'nothing', 'nulls', 'others', 'plan', 'pragma',
  'preceding', 'query', 'raise', 'reindex', 'rollback', 'savepoint', 'temp', 'temporary', 'ties', 'transaction',
  'unbounded', 'vacuum', 'view', 'without',
]);
