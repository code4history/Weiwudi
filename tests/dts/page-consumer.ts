// 配布の dist/weiwudi.d.ts（@c4h/weiwudi の型）を利用者の立場で使う（m2-t8・第 1 回 S12・C4・第 2 回 D3）。
// `node_modules/.bin/tsc -p tests/dts/tsconfig.json` で型検査する（build の後）。
// 名前があるだけでは通らない: 各型の全項目へ型つきで代入し、形が違えば Equals の検査で型エラーになる。
import Weiwudi, {
  WeiwudiError, WeiwudiSource,
  type CommonPolicy, type Credentials, type OutOfRange, type ResourceInfo, type ResourceType,
  type SourceInfo, type SourceSpec, type SourceStats, type TileBox, type UsageReport, type WeiwudiErrorCode,
} from '../../dist/weiwudi';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(_v?: T): void => undefined;

assertType<Equals<ResourceType, 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data'>>();
assertType<Equals<OutOfRange, 'transparent' | 'empty' | 'not-found'>>();
assertType<Equals<TileBox, { minX: number; maxX: number; minY: number; maxY: number }>>();
assertType<Equals<Credentials, { query?: Record<string, string>; headers?: Record<string, string> }>>();
assertType<Equals<ResourceInfo, {
  id: string; type: ResourceType; templates: string[];
  count: number; bytes: number;
  rangeOnly?: true; corsless?: true;
}>>();
assertType<Equals<CommonPolicy, {
  cacheTtl?: number; cacheRetention?: number; cacheMaxBytes?: number; cachePrivate?: boolean;
  credentials?: Credentials; credentialParams?: string[];
}>>();
assertType<Equals<SourceSpec['kind'], 'raster' | 'vector' | 'style' | 'asset'>>();
assertType<Equals<SourceInfo, {
  id: string; kind: SourceSpec['kind']; url: string | string[];
  resources: ResourceInfo[]; warnings: string[];
}>>();
assertType<Equals<SourceStats, {
  count: number; size: number; total?: number; percent?: number;
  byResource: Record<string, { count: number; bytes: number }>;
}>>();
assertType<Equals<UsageReport, {
  count: number; bytes: number;
  byProvider: Record<string, { count: number; bytes: number }>;
}>>();

// 閉じた union は minor で増える。利用者は default を置いた switch で受ける（m3-t8・I4・O-N6）
const describeCode = (code: WeiwudiErrorCode): string => {
  switch (code) {
    case 'resource-not-found': return 'resource';
    case 'source-not-found': return 'source';
    default: return code;
  }
};
const describeType = (type: ResourceType): string => {
  switch (type) {
    case 'tile': return 'tile';
    case 'glyph': return 'glyph';
    default: return type;
  }
};
void [describeCode, describeType];

// 全項目への型つきの代入
const box: TileBox = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
const outOfRange: OutOfRange = 'empty';
const credentials: Credentials = { query: { access_token: 'pk.x' }, headers: { 'x-key': 'v' } };
const policy: CommonPolicy = {
  cacheTtl: 1, cacheRetention: 2, cacheMaxBytes: 3, cachePrivate: false, credentials, credentialParams: ['k'],
};
const raster: SourceSpec = {
  ...policy, kind: 'raster', id: 'r', url: ['https://a.example/{z}/{x}/{y}.png'],
  bounds: [139, 35, 140, 36], minZoom: 0, maxZoom: 10, scheme: 'xyz', tileSize: 256,
  outOfRange: { extent: outOfRange, zoom: 'not-found' },
};
const pixel: SourceSpec = { kind: 'vector', url: 'https://a.example/{z}/{x}/{y}.pbf', box, maxZoom: 3, scheme: 'tms' };
const style: SourceSpec = { kind: 'style', id: 's', url: 'https://a.example/style.json', fonts: ['Noto Sans'] };
const asset: SourceSpec = { kind: 'asset', url: ['https://a.example/a.png'] };
void [pixel, style, asset];

const resource: ResourceInfo = {
  id: 'https://a.example/{z}/{x}/{y}.png', type: 'tile', templates: ['https://a.example/{z}/{x}/{y}.png'],
  count: 1, bytes: 2, rangeOnly: true, corsless: true,
};
const info: SourceInfo = { id: 'r', kind: 'raster', url: 'https://a.example/{z}/{x}/{y}.png', resources: [resource], warnings: ['w'] };
const stats: SourceStats = { count: 1, size: 2, total: 3, percent: 33, byResource: { [resource.id]: { count: 1, bytes: 2 } } };
void [info, stats];

// Weiwudi.register の戻り値を WeiwudiSource として使う（m2 のメンバだけ）
const use = async (): Promise<void> => {
  const src: WeiwudiSource = await Weiwudi.register(raster);
  const id: string = src.id;
  const url: string | string[] = src.url;
  const resources: ResourceInfo[] = src.resources;
  const warnings: string[] = src.warnings;
  const s: SourceStats = await src.stats();
  const u: void = await src.update();
  const c: void = await src.clean();
  const r: void = await src.remove();
  const rel: void = src.release();
  const again: WeiwudiSource = await Weiwudi.source(id);
  const all: SourceInfo[] = await Weiwudi.sources();
  void [url, resources, warnings, s, u, c, r, rel, again, all];
  // kind: 'style'・'asset' の登録（m3-t7）。スタイルの url は地図ライブラリへ渡す https の URL
  const st: WeiwudiSource = await Weiwudi.register(style);
  const styleUrl: string | string[] = st.url;
  const as: WeiwudiSource = await Weiwudi.register(asset);
  void [styleUrl, as];
  // 資源単位の削除と使用量（m3-t8）
  const rr: void = await src.removeResource(resources[0].id);
  const usage: UsageReport = await Weiwudi.usage();
  const total: number = usage.count;
  const size: number = usage.bytes;
  const byProvider: Record<string, { count: number; bytes: number }> = usage.byProvider;
  const mapboxBytes: number | undefined = byProvider.mapbox?.bytes;
  void [rr, total, size, mapboxBytes];
  try {
    await Weiwudi.register({ kind: 'style', url: 'https://a.example/broken.json' });
  } catch (e) {
    const code: string = WeiwudiError.from(e).code;
    void code;
  }
};
void use;
