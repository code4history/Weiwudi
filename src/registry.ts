// 合流と実効方針（仕様 §5.1・§5.6。m2-t6）。register・update・remove の Resource と Source の書き換えはここだけで行う。
// 値の依存は url_pattern・errors だけ（仕様 §3 の許可は store・spec・url_pattern・tile_math・errors）。
//
// 決まり:
// - planRegister・composePolicy・isExclusiveTo・credentialSourceFor は純粋関数（IndexedDB を使わない）
// - Resource の書き換えは createResource・replaceResource・patchResource だけ（count・bytes を store が引き継ぐ。第 1 回 S2）
// - id は spec.ts の正規化済みの値だけを使う（第 1 回 C3）。warnings は "<code>: <Resource.id>"（R12）
// - 旧 API の Resource（map: で始まる id）は合流の候補に入れず、書き換えない（第 2 回 S-6）
import type { OutOfRange, ResourceMeta, ResourcePolicy, SourceRecord, Store, TileExtent } from './store';
import type { NormalizedSpec, StoredSpec } from './spec';
import { WeiwudiError } from './errors';
import { MAX_TILE_ZOOM, templatesOverlap } from './url_pattern';

/** 旧 API の Source と Resource の id の前置き（仕様 §5.1） */
const LEGACY_PREFIX = 'map:';

const isLegacy = (r: ResourceMeta): boolean => r.id.startsWith(LEGACY_PREFIX);

const without = (xs: readonly string[] | undefined, id: string): string[] => (xs ?? []).filter((x) => x !== id);

const unique = (xs: readonly string[]): string[] => xs.filter((x, i) => xs.indexOf(x) === i);

/** 名前の大文字小文字を問わない和（先に出た綴りを残す） */
const unionParams = (...lists: (readonly string[])[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const p of list) {
      const lower = p.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(p);
    }
  }
  return out;
};

/** 新 API の Source の登録内容。旧 API（kind: 'legacy'・spec: {}）は undefined */
const storedSpecOf = (rec: SourceRecord): StoredSpec | undefined =>
  rec.kind !== 'legacy' && 'templates' in rec.spec ? (rec.spec as StoredSpec) : undefined;

const byOrder = (a: SourceRecord, b: SourceRecord): number => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const specsOf = (sources: readonly SourceRecord[]): StoredSpec[] =>
  sources.slice().sort(byOrder).map(storedSpecOf).filter((s): s is StoredSpec => s !== undefined);

// ---- 実効方針（仕様 §5.6 の表） ----

/** 範囲外の型の既定（仕様 §6）。ラスタは transparent、ベクタは empty */
const defaultOutOfRange = (encoding: ResourceMeta['encoding']): OutOfRange => (encoding === 'vector' ? 'empty' : 'transparent');

/**
 * Source の範囲を Resource の scheme で読み替えた TileExtent（写しを返す）。範囲の指定が無ければ全域
 * （box なし・ズーム 0〜MAX_TILE_ZOOM）。scheme が違えば maxZoom で y を反転する（ズームはそのまま）
 */
const extentOf = (s: StoredSpec, scheme: ResourceMeta['scheme']): TileExtent => {
  const e: TileExtent = s.extent
    ? { ...s.extent, sourceId: s.id }
    : { minZoom: 0, maxZoom: MAX_TILE_ZOOM, sourceId: s.id };
  if (e.box) {
    const box = { ...e.box };
    if (s.scheme !== (scheme ?? 'xyz')) {
      const last = Math.pow(2, e.maxZoom) - 1;
      box.minY = last - e.box.maxY;
      box.maxY = last - e.box.minY;
    }
    e.box = box;
  }
  return e;
};

/**
 * 実効方針（仕様 §5.6）。sources は sourceIds の Source、rangeOnly は rangeOnlySourceIds の Source。
 * extents は両方の範囲の和、その他は sources だけから作る。credentialParams は Entry がある間（count > 0）は
 * 今の値のまま（縮めない。広がる合流は planRegister が先に拒否する）。sources に新 API の Source が無ければ今の方針と、rangeOnly だけから作った範囲を返す。
 * extraPolicies は仮の参加者の方針（keep の Source がいるときの今の方針。PR #77 N1）で、範囲以外の合成に Source と同じ規則で入る
 */
export function composePolicy(
  resource: ResourceMeta,
  sources: SourceRecord[],
  rangeOnly: SourceRecord[],
  extraPolicies: readonly ResourcePolicy[] = [],
): Pick<ResourceMeta, 'policy' | 'extents'> {
  const specs = specsOf(sources);
  const extents = [...specs, ...specsOf(rangeOnly)].map((s) => extentOf(s, resource.scheme));
  if (specs.length === 0) return { policy: resource.policy, extents };

  const policies = [...specs.map((s) => s.policy), ...extraPolicies];
  const pick = (k: 'extent' | 'zoom'): OutOfRange => {
    const vs = policies.map((p) => p.outOfRange[k]);
    return vs.every((v) => v === vs[0]) ? vs[0] : defaultOutOfRange(resource.encoding);
  };
  const policy: ResourcePolicy = {
    cacheTtl: Math.min(...policies.map((p) => p.cacheTtl)),
    store: policies.every((p) => p.store),
    outOfRange: { extent: pick('extent'), zoom: pick('zoom') },
    credentialParams: resource.count > 0
      ? resource.policy.credentialParams.slice()
      : unionParams(...policies.map((p) => p.credentialParams)),
  };
  const retentions = policies.map((p) => p.cacheRetention);
  if (retentions.every((r): r is number => r !== undefined)) policy.cacheRetention = Math.max(...retentions);
  return { policy, extents };
}

/** Resource のテンプレート: sourceIds の Source のテンプレートの和（登録順）。無ければ今の値 */
const composeTemplates = (resource: ResourceMeta, sources: readonly SourceRecord[]): string[] => {
  const all = unique(([] as string[]).concat(...specsOf(sources).map((s) => s.templates)));
  return all.length > 0 ? all : resource.templates.slice();
};

/**
 * 資格情報を使う Source（仕様 §5.6 の表の「資格情報」）: sourceIds の Source を登録順（order）に見て、
 * withCredentials にある最初のもの。無ければ undefined
 */
export function credentialSourceFor(
  resource: ResourceMeta,
  sources: readonly SourceRecord[],
  withCredentials: readonly string[],
): string | undefined {
  const hit = sources
    .filter((s) => resource.sourceIds.indexOf(s.id) >= 0 && withCredentials.indexOf(s.id) >= 0)
    .sort(byOrder)[0];
  return hit?.id;
}

/**
 * clean・remove の唯一の判定（第 1 回 O-2・O-15）: sourceIds がその Source だけで、rangeOnlySourceIds に他が無い
 */
export function isExclusiveTo(resource: ResourceMeta, sourceId: string): boolean {
  return resource.sourceIds.length > 0
    && resource.sourceIds.every((id) => id === sourceId)
    && (resource.rangeOnlySourceIds ?? []).every((id) => id === sourceId);
}

// ---- 計画 ----

export interface RegisterPlan {
  sourceId: string;
  /** 通常の合流先（sourceIds に入る）。create は新しく作る。衝突したときは無い */
  join?: { resourceId: string; create: boolean };
  /** 衝突したが範囲だけ足す（rangeOnlySourceIds に入る。新しい id か、まだ属していない Resource） */
  rangeOnly: string[];
  /** 既に属していて衝突した Resource（S-I）。古い方針と古い範囲のまま sourceIds に残し、書き換えない */
  keep: string[];
  /** 前の登録で参照していたが今回は参照しない Resource（sourceIds・rangeOnlySourceIds から外す） */
  leave: string[];
  /** 衝突した Resource（keep と rangeOnly の和。update() はこれが空でなければ失敗） */
  conflicts: string[];
  /** "resource-conflict: <Resource.id>" */
  warnings: string[];
}

/** 合流の拒否の理由（仕様 §5.6）。合流できれば undefined */
const conflictOf = (r: ResourceMeta, s: StoredSpec): string | undefined => {
  if (r.type !== 'tile') return 'type';
  if ((r.encoding ?? s.kind) !== s.kind) return 'encoding';
  if ((r.scheme ?? 'xyz') !== s.scheme) return 'scheme';
  if (r.count > 0) {
    const have = new Set(r.policy.credentialParams.map((p) => p.toLowerCase()));
    if (s.policy.credentialParams.some((p) => !have.has(p.toLowerCase()))) return 'credentialParams';
  }
  return undefined;
};

/** 新しい Resource の id: 先頭から順に、使われていないテンプレート。全部使われていれば先頭に #2・#3…を付ける */
const freeResourceId = (templates: readonly string[], taken: ReadonlySet<string>): string => {
  const free = templates.find((t) => !taken.has(t));
  if (free !== undefined) return free;
  for (let n = 2; ; n++) {
    const id = `${templates[0]}#${n}`;
    if (!taken.has(id)) return id;
  }
};

/**
 * 登録の計画（純粋関数）。candidates は保存済みの全 Resource（旧 API の Resource は除いて見る）。
 * 重なり（templatesOverlap）は両方の credentialParams の和で除いた形で見る
 */
export function planRegister(spec: NormalizedSpec, existing: SourceRecord | undefined, candidates: ResourceMeta[]): RegisterPlan {
  const s = spec.spec;
  const id = s.id;
  const pool = candidates.filter((r) => !isLegacy(r));
  const overlapping = pool.filter((r) =>
    templatesOverlap(r.templates, s.templates, unionParams(s.policy.credentialParams, r.policy.credentialParams)));
  const plan: RegisterPlan = { sourceId: id, rangeOnly: [], keep: [], leave: [], conflicts: [], warnings: [] };

  if (overlapping.length === 0) {
    plan.join = { resourceId: freeResourceId(s.templates, new Set(candidates.map((r) => r.id))), create: true };
  } else if (overlapping.length === 1 && conflictOf(overlapping[0], s) === undefined) {
    plan.join = { resourceId: overlapping[0].id, create: false };
  } else {
    // 2 つ以上に重なるか、1 つと衝突した
    for (const r of overlapping) {
      plan.conflicts.push(r.id);
      plan.warnings.push(`resource-conflict: ${r.id}`);
      if (existing !== undefined && r.sourceIds.indexOf(id) >= 0) plan.keep.push(r.id);
      else plan.rangeOnly.push(r.id);
    }
  }
  plan.leave = pool
    .filter((r) => overlapping.indexOf(r) < 0
      && (r.sourceIds.indexOf(id) >= 0 || (r.rangeOnlySourceIds ?? []).indexOf(id) >= 0))
    .map((r) => r.id);
  return plan;
}

// ---- 保存 ----

type Lookup = (ids: readonly string[] | undefined) => SourceRecord[];

const lookupOf = (sources: readonly SourceRecord[]): Lookup => {
  const byId = new Map(sources.map((r) => [r.id, r]));
  return (ids) => (ids ?? []).map((i) => byId.get(i)).filter((r): r is SourceRecord => r !== undefined);
};

/**
 * keep（S-I）の Source か: 自分の warnings にその Resource との衝突を持つ。その Source の保存済みの spec は新しい登録内容で、
 * この Resource に入れると別の Resource のテンプレートや新しい方針が混ざる（PR #77 水準 1 M1）
 */
const isKeptIn = (rec: SourceRecord, resourceId: string): boolean =>
  rec.warnings.indexOf(`resource-conflict: ${resourceId}`) >= 0;

/**
 * Resource の合成（方針・範囲・テンプレート）。keep の Source の spec はどこにも入れない:
 * - 方針: 通常の Source から作る。keep の Source がいれば今の方針（m.policy）を仮の参加者 1 つとして同じ規則で入れる
 *   （credentialParams は和・store は論理積・cacheTtl は最短…。keep が続くあいだ方針は緩まない向きにだけ動く。PR #77 N1）。
 *   通常の Source が無ければ今の方針のまま
 * - 範囲: 通常の Source と範囲だけの Source から作り、keep の Source は保存済みの extents（古い範囲）を残す
 * - テンプレート: keep の Source が無ければ通常の Source の和。あれば今の値に通常の Source の分を足す（keep の古いミラーを落とさない）
 */
const composeFor = (m: ResourceMeta, recs: Lookup): Pick<ResourceMeta, 'policy' | 'extents' | 'templates'> => {
  const members = recs(m.sourceIds);
  const active = members.filter((r) => !isKeptIn(r, m.id));
  const kept = members.filter((r) => isKeptIn(r, m.id)).map((r) => r.id);
  const own = active.length > 0
    ? composePolicy(m, active, [], kept.length > 0 ? [m.policy] : [])
    : { policy: m.policy, extents: [] };
  const oldKept = (m.extents ?? []).filter((e) => kept.indexOf(e.sourceId) >= 0).map((e) => ({ ...e }));
  const rangeOnly = composePolicy(m, [], recs(m.rangeOnlySourceIds)).extents ?? [];
  const templates = kept.length === 0
    ? composeTemplates(m, active)
    : unique([...m.templates, ...composeTemplates(m, active)]);
  return { policy: own.policy, extents: [...(own.extents ?? []), ...oldKept, ...rangeOnly], templates };
};

/** sourceIds が変わった Resource を合成し直す（方針・範囲・テンプレート） */
const recompose = (m: ResourceMeta, recs: Lookup): ResourceMeta => {
  const next: ResourceMeta = { ...m, ...composeFor(m, recs) };
  if (next.policy.cacheRetention === undefined) delete next.policy.cacheRetention;
  return next;
};

/** rangeOnlySourceIds だけが変わった Resource は範囲だけを計算し直す（方針は sourceIds の Source だけから作るので変わらない） */
const recomposeExtents = (m: ResourceMeta, recs: Lookup): ResourceMeta => ({ ...m, extents: composeFor(m, recs).extents });

const setRangeOnly = (m: ResourceMeta, ids: string[]): ResourceMeta => {
  const next = { ...m };
  if (ids.length > 0) next.rangeOnlySourceIds = ids;
  else delete next.rangeOnlySourceIds;
  return next;
};

/**
 * Resource から Source を外す。sourceIds が空になれば rangeOnlySourceIds が残っていても Entry ごと消す（仕様 §5.6）。
 * 旧 API の Resource は新 API の Source を参照に持たない（planRegister が候補から除く）ので、ここへは来ない
 */
const detach = async (store: Store, resourceId: string, sourceId: string, recs: Lookup): Promise<void> => {
  const r = await store.getResource(resourceId);
  if (!r) return;
  if (without(r.sourceIds, sourceId).length === 0) {
    await store.deleteResource(resourceId);
    return;
  }
  await store.patchResource(resourceId, (m) => {
    const inSources = m.sourceIds.indexOf(sourceId) >= 0;
    const next = setRangeOnly({ ...m, sourceIds: without(m.sourceIds, sourceId) }, without(m.rangeOnlySourceIds, sourceId));
    return inSources ? recompose(next, recs) : recomposeExtents(next, recs);
  });
};

export interface RegisterResult {
  source: SourceRecord;
  /** この Source が参照する Resource（合流先・keep・範囲だけ）の保存後の値 */
  resources: ResourceMeta[];
  /** 登録の時点の写し */
  warnings: string[];
}

const apply = async (
  store: Store,
  spec: NormalizedSpec,
  existing: SourceRecord | undefined,
  mode: 'register' | 'update',
): Promise<RegisterResult> => {
  const s = spec.spec;
  const id = s.id;
  const plan = planRegister(spec, existing, await store.listResources());
  if (mode === 'update' && plan.conflicts.length > 0) {
    // 自分自身の update() の衝突は全体を失敗させ、何も変えない（仕様 §5.6）
    throw new WeiwudiError('resource-conflict', `Source "${id}" conflicts with ${plan.conflicts.length} resource(s)`,
      { resourceIds: plan.conflicts.slice() });
  }

  const order = existing ? existing.order : (await store.listSources()).reduce((n, r) => Math.max(n, r.order), 0) + 1;
  const record: SourceRecord = {
    id, kind: s.kind, spec: s, order, warnings: plan.warnings.slice(), createdAt: existing?.createdAt ?? Date.now(),
  };
  // Source を先に書く（合成が新しい登録内容を読む。途中で止まっても remove() で外せる）
  await store.putSource(record);
  if (spec.credentials) await store.putCredentials(id, spec.credentials);
  else if (existing) await store.putCredentials(id, {});
  const recs = lookupOf(await store.listSources());

  if (plan.join?.create) {
    const base: ResourceMeta = {
      id: plan.join.resourceId,
      type: 'tile',
      templates: s.templates.slice(),
      sourceIds: [id],
      encoding: s.kind,
      scheme: s.scheme,
      policy: s.policy,
      count: 0,
      bytes: 0,
      pinnedBytes: 0,
    };
    await store.createResource(recompose(base, recs));
  } else if (plan.join) {
    await store.patchResource(plan.join.resourceId, (m) => {
      const sourceIds = m.sourceIds.indexOf(id) >= 0 ? m.sourceIds.slice() : [...m.sourceIds, id];
      const next = recompose(setRangeOnly({ ...m, sourceIds }, without(m.rangeOnlySourceIds, id)), recs);
      if (mode === 'update') {
        // update() は CORS の判定をやり直す（仕様 §4.5。count には触らない）
        delete next.corsOk;
        delete next.corslessUntil;
      }
      return next;
    });
  }
  for (const rid of plan.rangeOnly) {
    await store.patchResource(rid, (m) => {
      const ids = (m.rangeOnlySourceIds ?? []).indexOf(id) >= 0 ? m.rangeOnlySourceIds ?? [] : [...(m.rangeOnlySourceIds ?? []), id];
      return recomposeExtents(setRangeOnly(m, ids.slice()), recs);
    });
  }
  for (const rid of plan.leave) await detach(store, rid, id, recs);

  const ids = [...(plan.join ? [plan.join.resourceId] : []), ...plan.keep, ...plan.rangeOnly];
  const resources = (await Promise.all(ids.map((rid) => store.getResource(rid))))
    .filter((r): r is ResourceMeta => r !== undefined);
  return { source: record, resources, warnings: plan.warnings.slice() };
};

/**
 * 登録（仕様 §5.6）。衝突しても失敗にせず Source を保存し、warnings に書く。同じ id の再登録は、既に属している
 * Resource との衝突を keep（古い方針のまま）にし、参照が消えた Resource からは外す（第 1 回 O-11）
 */
export async function applyRegister(store: Store, spec: NormalizedSpec): Promise<RegisterResult> {
  const existing = await store.getSource(spec.spec.id);
  return apply(store, spec, existing && existing.kind !== 'legacy' ? existing : undefined, 'register');
}

/**
 * 自分自身の update()（仕様 §5.6）。衝突は WeiwudiError('resource-conflict') で、何も変えない。
 * 無い Source（旧 API の Source を含む）は source-not-found、spec の id が違えば attribute-invalid
 */
export async function applyUpdate(store: Store, sourceId: string, spec: NormalizedSpec): Promise<RegisterResult> {
  const existing = await store.getSource(sourceId);
  if (!existing || existing.kind === 'legacy') {
    throw new WeiwudiError('source-not-found', `Source "${sourceId}" not found`, { sourceId });
  }
  if (spec.spec.id !== sourceId) {
    throw new WeiwudiError('attribute-invalid', 'Attribute "id" must not change in update()', { attribute: 'id' });
  }
  return apply(store, spec, existing, 'update');
}

/**
 * 削除（仕様 §5.6）。参照している Resource から外し（sourceIds が空になれば Entry ごと消す）、
 * 範囲だけの Resource から外して和を計算し直し、最後に Source・資格情報・region を消す。
 * 無い Source（旧 API の Source を含む）は source-not-found
 */
export async function applyRemove(store: Store, sourceId: string): Promise<void> {
  const existing = await store.getSource(sourceId);
  if (!existing || existing.kind === 'legacy') {
    throw new WeiwudiError('source-not-found', `Source "${sourceId}" not found`, { sourceId });
  }
  const recs = lookupOf((await store.listSources()).filter((r) => r.id !== sourceId));
  const ids = unique([
    ...(await store.resourcesBySource(sourceId)).map((r) => r.id),
    ...(await store.resourcesByRangeOnlySource(sourceId)).map((r) => r.id),
  ]);
  for (const rid of ids) await detach(store, rid, sourceId, recs);
  await store.deleteSource(sourceId);
}
