// SW 側の src/ にモジュール変数（可変の状態）を置かないことを確かめる（m2-t1・第 1 回 S1・第 2 回 O7）。
// 可変の状態は Weiwudi_Internal の呼び出しごとの実行文脈（context.ts）に置く。これで 1 試験 1 SW になる。
//
// 見るもの（ファイルの最上位の宣言だけ）:
// - `let`・`var` があれば失敗（`declare` は除く）
// - `const` の初期値が `new Map`・`new Set`・`new WeakMap`・`new WeakSet`・配列の literal・object の literal なら失敗
//   （`as const`・`satisfies`・括弧・型の表明は剥がして見る）
// - ただし型の注記が `Readonly` か `readonly` で始まる宣言と、下の許可の一覧の名前は許す
// 見ないもの:
// - plugins.ts（差し込み口の登録表だけはモジュール変数に置く。試験用の _resetPluginsForTest つき）
// - ページ側の weiwudi.ts（1 つのページの 1 つの module 実例が 1 つの利用者で、SW のように 1 プロセスに
//   複数の実行文脈が同居しない。swCheck の記憶と t8 の ensureV2() の記憶はここに置く。第 3 回 S-A）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const EXCLUDED = new Set(['plugins.ts', 'weiwudi.ts']);

// 許可の一覧（ファイル → 名前と理由）。足すときは理由を 1 行書く
const ALLOWED: Record<string, Record<string, string>> = {
  'errors.ts': {
    LEGACY_CODES: '旧 API のコードの表。書き換えない（as const）',
    OTHER_CODES: 'ほかのコードの表。書き換えない（as const）',
    NEW_API_CODES: '新 API のコードの表。書き換えない（as const）',
    KNOWN_CODES: '既知のコードの集合。書き換えない（ReadonlySet）',
    LEGACY_TABLE: '旧 API の文面の表。書き換えない（readonly）',
    TEMPLATES: '旧 API の文面の索引（Map）。読み込み時に作り、以後は読むだけ',
  },
};

const MUTABLE_CONSTRUCTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)
      || ts.isTypeAssertionExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
};

const isMutableContainer = (init: ts.Expression): boolean => {
  const e = unwrap(init);
  if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) return true;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) return MUTABLE_CONSTRUCTORS.has(e.expression.text);
  return false;
};

/** 最上位の可変の状態の名前と理由。許可の一覧は見ない（呼び出し側で外す） */
const findModuleState = (code: string, fileName = 'x.ts'): { name: string; reason: string }[] => {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { name: string; reason: string }[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    const flags = st.declarationList.flags;
    const isConst = (flags & ts.NodeFlags.Const) !== 0;
    for (const d of st.declarationList.declarations) {
      const name = d.name.getText(sf);
      if (!isConst) {
        found.push({ name, reason: (flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var' });
        continue;
      }
      if (!d.initializer) continue;
      if (d.type && /^(readonly|Readonly)/.test(d.type.getText(sf))) continue;
      if (isMutableContainer(d.initializer)) found.push({ name, reason: 'mutable container' });
    }
  }
  return found;
};

const listSwSources = (dir = SRC): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSwSources(full);
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) return [];
    const rel = relative(SRC, full).split(sep).join('/');
    return EXCLUDED.has(rel) ? [] : [rel];
  });

describe('検査の読み取り（自己確認）', () => {
  it('let・var と、可変の入れ物を作る const を見つける', () => {
    const code = [
      'let a = 1;',
      'var b;',
      'export let c = 2;',
      'const cache = new Map();',
      'const seen = new WeakSet<object>();',
      'const list = [1, 2];',
      'const obj = { k: 1 };',
      'const frozenList = [1, 2] as const;',
    ].join('\n');
    expect(findModuleState(code).map((f) => f.name)).toEqual(['a', 'b', 'c', 'cache', 'seen', 'list', 'obj', 'frozenList']);
  });

  it('readonly・Readonly の注記、関数・正規表現・呼び出しの結果・declare は見ない', () => {
    const code = [
      'const A: readonly string[] = [];',
      'const B: ReadonlyMap<string, number> = new Map();',
      'const C: Readonly<Record<string, number>> = {};',
      'const f = () => 1;',
      'const re = /\\$\\{(\\w+)\\}/g;',
      'const derived = A.map((x) => x);',
      'const sym = Symbol.for("x");',
      'declare let self: unknown;',
      'function g() { let inner = 1; return inner; }',
    ].join('\n');
    expect(findModuleState(code)).toEqual([]);
  });
});

describe('SW 側の src/ にモジュール変数が無い', () => {
  const files = listSwSources();

  it('対象のファイルがある（plugins.ts と weiwudi.ts は除く）', () => {
    expect(files).toContain('errors.ts');
    expect(files).toContain('weiwudi_gw_logic.ts');
    expect(files).not.toContain('weiwudi.ts');
  });

  it.each(files)('%s', (file) => {
    const allowed = ALLOWED[file] ?? {};
    const found = findModuleState(readFileSync(join(SRC, file), 'utf8'), file)
      .filter((f) => !Object.prototype.hasOwnProperty.call(allowed, f.name));
    expect(found).toEqual([]);
  });

  it('errors.ts の正規表現（PLACEHOLDER の /…/g）と LEGACY_TABLE.map(...) の MATCHERS は検査に掛からない（第 4 回 O-4 の実測）', () => {
    const found = findModuleState(readFileSync(join(SRC, 'errors.ts'), 'utf8'), 'errors.ts').map((f) => f.name);
    expect(found).not.toContain('PLACEHOLDER');
    expect(found).not.toContain('MATCHERS');
    // 掛かるのは許可の一覧の名前だけ
    expect(found.every((n) => Object.prototype.hasOwnProperty.call(ALLOWED['errors.ts'], n))).toBe(true);
  });
});
