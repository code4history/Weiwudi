// src/ の値の依存が、仕様 §3 の表の許可先だけであることを確かめる（m2-t1・第 1 回 O-2）。
// 正本は docs/superpowers/specs/2026-11-02-new-interface-spec.md §3 の表。ここはその全行を写したデータ。
// 後のタスクはこのファイルを触らない（表の全行を t1 で持つ。m2-t1・m3-t1）。
//
// 数えるもの: `import … from`・`export … from`・`import '…'`（複数行も）・動的な `import('…')`。
// 数えないもの: `import type`・`export type`・型だけの指定子（`import { type A }`）だけの import・相対でない行き先。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

// 表の 1 行 = 1 モジュール。providers/ の下の全ファイルが providers の行（m3-t1 で plugins と行を分けた）。
// constants は全ファイルが import してよい（表の注。constants 自身は何も import しない）
const ABOVE_ALL = [
  'constants', 'tile_math', 'errors', 'url_pattern', 'spec', 'style_body', 'plugins', 'providers', 'store', 'context',
  'registry', 'upstream', 'core', 'hook', 'style', 'range', 'control', 'legacy', 'migrate',
];
const DEPS_TABLE: Record<string, readonly string[]> = {
  constants: [],
  tile_math: [],
  errors: [],
  url_pattern: ['tile_math', 'constants', 'errors'],
  spec: ['url_pattern', 'tile_math', 'constants', 'errors'],
  style_body: ['url_pattern', 'constants', 'errors'],
  plugins: ['constants', 'errors'],
  providers: ['errors', 'constants'],
  store: ['constants', 'errors'],
  context: ['store', 'constants', 'errors'],
  registry: ['store', 'spec', 'url_pattern', 'tile_math', 'constants', 'errors'],
  upstream: ['context', 'store', 'url_pattern', 'constants', 'errors'],
  core: ['context', 'store', 'plugins', 'url_pattern', 'tile_math', 'constants', 'errors'],
  hook: ['core', 'upstream', 'context', 'store', 'url_pattern', 'style_body', 'constants', 'errors'],
  style: ['hook', 'core', 'registry', 'spec', 'style_body', 'url_pattern', 'context', 'store', 'constants', 'errors'],
  // m4 で range を足す（m4-t1。range.ts は t3 で作る）
  range: ['hook', 'core', 'upstream', 'registry', 'context', 'store', 'spec', 'url_pattern', 'tile_math', 'style_body', 'constants', 'errors'],
  control: ['hook', 'core', 'registry', 'spec', 'style', 'range', 'context', 'store', 'tile_math', 'constants', 'errors'],
  // m4 で migrate を足す（表の「（m4 で migrate）」）
  legacy: ['core', 'context', 'store', 'tile_math', 'constants', 'errors', 'migrate'],
  migrate: ['store', 'constants', 'errors'],
  // 「上の全部」
  weiwudi_gw_logic: ABOVE_ALL,
  weiwudi_gw: ['weiwudi_gw_logic', 'plugins', 'constants'],
  weiwudi_sw: ['weiwudi_gw_logic', 'plugins', 'constants'],
  weiwudi: ['errors', 'url_pattern', 'constants'],
};

/** src/ の中の .ts（*.d.ts を除く）を、src からの相対の posix パスで返す */
const listSources = (dir = SRC): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) return [];
    return [relative(SRC, full).split(sep).join('/')];
  });

/** src からの相対パス（拡張子なし可）→ 表の行の名前。表に無ければ undefined */
const moduleOf = (relPath: string): string | undefined => {
  const p = relPath.replace(/\.ts$/, '').replace(/\/index$/, '');
  if (p === 'providers' || p.startsWith('providers/')) return 'providers';
  return Object.prototype.hasOwnProperty.call(DEPS_TABLE, p) ? p : undefined;
};

/** 値の依存の行き先（ファイル内に書かれた文字列のまま）。型だけのものは除く */
const valueImports = (code: string, fileName = 'x.ts'): string[] => {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((e) => e.isTypeOnly)) continue;
      out.push((st.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      if (st.isTypeOnly) continue;
      if (st.exportClause && ts.isNamedExports(st.exportClause)
        && st.exportClause.elements.length > 0
        && st.exportClause.elements.every((e) => e.isTypeOnly)) continue;
      out.push((st.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  // 動的な import('…')（CallExpression の ImportKeyword）も値の依存。どの深さにあっても拾う。
  // 行き先が文字列の literal でないもの（変数など）は静的に決まらないので数えない
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

/** ファイル（src からの相対）が値で依存している表の行の名前。相対でない行き先は除く */
const dependenciesOf = (relPath: string, code: string): string[] =>
  valueImports(code, relPath)
    .filter((spec) => spec.startsWith('./') || spec.startsWith('../'))
    .map((spec) => {
      const target = posix.normalize(posix.join(posix.dirname(relPath), spec));
      return moduleOf(target) ?? `?${target}`;
    });

describe('依存の読み取り（自己確認）', () => {
  it('import・export … from・副作用の import を、複数行でも読み、型だけのものは除く', () => {
    const code = [
      "import { a,",
      "  b } from './one';",
      "import type { T } from './typeonly';",
      "import { type U } from './typespec';",
      "import { type V, w } from './mixed';",
      "export { x } from './two';",
      "export type { Y } from './typeexport';",
      "export * from './star';",
      "import './side';",
      "import ext from 'workbox-core';",
    ].join('\n');
    expect(valueImports(code)).toEqual(['./one', './mixed', './two', './star', './side', 'workbox-core']);
  });

  it('動的な import(…) も、関数の中でも拾う（行き先が literal のものだけ）', () => {
    const code = [
      "export const lazy = () => import('./errors');",
      "async function f(p: string) { await import(`./tpl`); return import(p); }",
      "type T = typeof import('./typeonly');",
    ].join('\n');
    expect(valueImports(code)).toEqual(['./errors', './tpl']);
  });
});

describe('仕様 §3 の依存の表', () => {
  const files = listSources();

  it('src/ のファイルはすべて表にある', () => {
    const unknown = files.filter((f) => moduleOf(f) === undefined);
    expect(unknown).toEqual([]);
  });

  it.each(Object.keys(DEPS_TABLE))('%s の値の依存は表の許可先だけ（まだ無いファイルは飛ばす）', (mod) => {
    const own = files.filter((f) => moduleOf(f) === mod);
    for (const file of own) {
      const deps = dependenciesOf(file, readFileSync(join(SRC, file), 'utf8'));
      // 同じ行の中（providers/ の下どうし）は許す
      const notAllowed = deps.filter((d) => d !== mod && !DEPS_TABLE[mod].includes(d));
      expect(notAllowed, `${file} の依存 ${JSON.stringify(deps)}`).toEqual([]);
    }
  });
});
