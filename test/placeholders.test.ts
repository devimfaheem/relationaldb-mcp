import { describe, expect, it } from 'vitest';
import { compile, extractPlaceholders } from '../src/shared/placeholders.js';

const Q = 'SELECT * FROM t WHERE a = :a AND b = :b OR a2 = :a';

describe('compile', () => {
  it('mysql uses ? and repeats values', () => {
    expect(compile(Q, 'mysql', { a: 1, b: 2 })).toEqual({
      sql: 'SELECT * FROM t WHERE a = ? AND b = ? OR a2 = ?',
      values: [1, 2, 1],
    });
  });

  it('postgres uses $n and reuses indexes', () => {
    expect(compile(Q, 'postgres', { a: 1, b: 2 })).toEqual({
      sql: 'SELECT * FROM t WHERE a = $1 AND b = $2 OR a2 = $1',
      values: [1, 2],
    });
  });

  it('mssql uses @name and a named map', () => {
    expect(compile(Q, 'mssql', { a: 1, b: 2 })).toEqual({
      sql: 'SELECT * FROM t WHERE a = @a AND b = @b OR a2 = @a',
      values: { a: 1, b: 2 },
    });
  });

  it('compiles missing args to null', () => {
    expect(compile('SELECT :x', 'mysql', {}).values).toEqual([null]);
  });
});

describe('extractPlaceholders', () => {
  it('ignores literals, quoted identifiers, comments and :: casts', () => {
    const q =
      "SELECT x::int, ':nope', \"col:x\", `c:y`, [d:z] -- :c\n /* :d */ FROM t WHERE id = :id";
    expect(extractPlaceholders(q)).toEqual(['id']);
    expect(compile(q, 'postgres', { id: 5 }).sql).toBe(
      "SELECT x::int, ':nope', \"col:x\", `c:y`, [d:z] -- :c\n /* :d */ FROM t WHERE id = $1",
    );
  });

  it('handles escaped quotes', () => {
    expect(extractPlaceholders("SELECT 'it''s :x' WHERE y = :y")).toEqual(['y']);
  });

  it('returns unique names in first-seen order', () => {
    expect(extractPlaceholders(Q)).toEqual(['a', 'b']);
  });
});
