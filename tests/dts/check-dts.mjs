// 配布の d.ts が、入口から相対で辿れる先をすべて持つことを確かめる（m2-t4・第 1 回 S12・第 2 回 D3）。
// 使い方: node tests/dts/check-dts.mjs dist/weiwudi_gw.d.ts（build の後に走らせる。vitest は拾わない）
//
// 辿るもの: `import … from '…'`・`export … from '…'`・`import '…'`・`import('…')`・
// `/// <reference path="…" />` の相対の行き先（型だけの import も辿る。d.ts の中はすべて型なので）。
// 行き先 x は x.d.ts・x/index.d.ts（x が .js で終われば .d.ts に置き換える）の順で探す。
// 1 つでも無ければ exit 1。辿ったファイルの一覧を出す。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node tests/dts/check-dts.mjs <entry.d.ts>');
  process.exit(2);
}

/** d.ts の中の相対の行き先（書かれたままの文字列） */
const specifiersOf = (file) => {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      out.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const ref of sf.referencedFiles) out.push(ref.fileName.startsWith('.') ? ref.fileName : `./${ref.fileName}`);
  return out.filter((s) => s.startsWith('./') || s.startsWith('../'));
};

const resolveDts = (from, spec) => {
  const base = resolve(dirname(from), spec.replace(/\.(js|mjs|cjs|ts)$/, ''));
  const candidates = spec.endsWith('.d.ts') ? [resolve(dirname(from), spec)] : [`${base}.d.ts`, resolve(base, 'index.d.ts')];
  return { found: candidates.find((c) => existsSync(c) && statSync(c).isFile()), tried: candidates };
};

const start = resolve(entry);
if (!existsSync(start)) {
  console.error(`missing entry: ${entry}`);
  process.exit(1);
}

const seen = new Set([start]);
const queue = [start];
const missing = [];
while (queue.length) {
  const file = queue.shift();
  for (const spec of specifiersOf(file)) {
    const { found, tried } = resolveDts(file, spec);
    if (!found) {
      missing.push(`${relative(process.cwd(), file)}: "${spec}" (tried ${tried.map((t) => relative(process.cwd(), t)).join(', ')})`);
      continue;
    }
    if (!seen.has(found)) {
      seen.add(found);
      queue.push(found);
    }
  }
}

for (const f of [...seen].sort()) console.log(`ok ${relative(process.cwd(), f)}`);
if (missing.length) {
  for (const m of missing) console.error(`missing ${m}`);
  process.exit(1);
}
