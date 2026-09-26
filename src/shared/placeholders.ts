export type Dialect = 'mysql' | 'postgres' | 'mssql';

type Token = { kind: 'text'; text: string } | { kind: 'param'; name: string };

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

// Pairs of opening -> closing delimiters whose contents are copied verbatim.
const QUOTES: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/**
 * Splits a query into literal text and `:name` placeholders, skipping string
 * literals, quoted identifiers, comments, and Postgres `::` casts.
 */
function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let i = 0;

  const flush = () => {
    if (text) tokens.push({ kind: 'text', text });
    text = '';
  };

  while (i < query.length) {
    const ch = query[i];
    const next = query[i + 1];

    if (ch in QUOTES) {
      const close = QUOTES[ch];
      let j = i + 1;
      while (j < query.length) {
        if (query[j] === close) {
          // A doubled closing quote ('' or "") is an escape, not the end.
          if (query[j + 1] === close && close !== ']') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      text += query.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '-' && next === '-') {
      const end = query.indexOf('\n', i);
      const j = end === -1 ? query.length : end;
      text += query.slice(i, j);
      i = j;
    } else if (ch === '/' && next === '*') {
      const end = query.indexOf('*/', i + 2);
      const j = end === -1 ? query.length : end + 2;
      text += query.slice(i, j);
      i = j;
    } else if (ch === ':' && next === ':') {
      text += '::';
      i += 2;
    } else if (ch === ':' && next !== undefined && IDENT_START.test(next)) {
      let j = i + 1;
      while (j < query.length && IDENT_CHAR.test(query[j])) j++;
      flush();
      tokens.push({ kind: 'param', name: query.slice(i + 1, j) });
      i = j;
    } else {
      text += ch;
      i++;
    }
  }
  flush();
  return tokens;
}

/** Unique placeholder names in the order they first appear. */
export function extractPlaceholders(query: string): string[] {
  const names = new Set<string>();
  for (const t of tokenize(query)) if (t.kind === 'param') names.add(t.name);
  return [...names];
}

/**
 * Rewrites `:name` placeholders into the dialect's native bound-parameter form.
 * Values are only ever returned separately — never spliced into the SQL.
 */
export function compile(
  query: string,
  dialect: Dialect,
  args: Record<string, unknown>,
): { sql: string; values: unknown[] | Record<string, unknown> } {
  const value = (name: string) => (args[name] === undefined ? null : args[name]);
  let sql = '';

  if (dialect === 'mssql') {
    const values: Record<string, unknown> = {};
    for (const t of tokenize(query)) {
      if (t.kind === 'text') sql += t.text;
      else {
        sql += `@${t.name}`;
        values[t.name] = value(t.name);
      }
    }
    return { sql, values };
  }

  const values: unknown[] = [];
  const indexes = new Map<string, number>();
  for (const t of tokenize(query)) {
    if (t.kind === 'text') sql += t.text;
    else if (dialect === 'mysql') {
      sql += '?';
      values.push(value(t.name));
    } else {
      let idx = indexes.get(t.name);
      if (idx === undefined) {
        values.push(value(t.name));
        idx = values.length;
        indexes.set(t.name, idx);
      }
      sql += `$${idx}`;
    }
  }
  return { sql, values };
}
