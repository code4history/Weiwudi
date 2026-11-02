// src/ の値の依存が、仕様 §3 の表の許可先だけであることを確かめる（m2-t1・第 1 回 O-2）。
// 正本は docs/superpowers/specs/2026-11-02-new-interface-spec.md §3 の表。ここはその全行を写したデータ。
// 後のタスクはこのファイルを触らない（表の全行を t1 で持つ）。
//
// 数えるもの: `import … from`・`export … from`・`import '…'`（複数行も）。
// 数えないもの: `import type`・`export type`・型だけの指定子（`import { type A }`）だけの import・相対でない行き先。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

// 表の 1 行 = 1 モジュール。`plugins.ts・providers/` は同じ行（providers/ の下の全ファイルが providers）
const ABOVE_ALL = [
  'tile_math', 'errors', 'url_pattern', 'spec', 'plugins', 'providers', 'store', 'context',
  'registry', 'upstream', 'core', 'hook', 'control', 'legacy', 'migrate',
];
const DEPS_TABLE: Record<string, readonly string[]> = {
  tile_math: [],
  errors: [],
  url_pattern: ['tile_math', 'errors'],
  spec: ['url_pattern', 'tile_math', 'errors'],
  plugins: ['errors'],
  providers: ['errors'],
  store: ['errors'],
  context: ['store', 'errors'],
  registry: ['store', 'spec', 'url_pattern', 'tile_math', 'errors'],
  upstream: ['context', 'store', 'url_pattern', 'errors'],
  core: ['context', 'store', 'plugins', 'url_pattern', 'tile_math', 'errors'],
  hook: ['core', 'upstream', 'context', 'store', 'url_pattern', 'errors'],
  control: ['hook', 'core', 'registry', 'spec', 'context', 'store', 'tile_math', 'errors'],
  // m4 で migrate を足す（表の「（m4 で migrate）」）
  legacy: ['core', 'context', 'store', 'tile_math', 'errors', 'migrate'],
  migrate: ['store', 'errors'],
  // 「上の全部」
  weiwudi_gw_logic: ABOVE_ALL,
  weiwudi_gw: ['weiwudi_gw_logic', 'plugins'],
  weiwudi_sw: ['weiwudi_gw_logic', 'plugins'],
  weiwudi: ['errors', 'url_pattern'],
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
