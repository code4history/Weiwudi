// 配布の dist/weiwudi_gw.d.ts（@c4h/weiwudi/sw の型）を利用者の立場で使う（m2-t4・第 2 回 D3）。
// `node_modules/.bin/tsc -p tests/dts/tsconfig.json` で型検査する（build の後）。
// 名前があるだけでは通らない: 形が違えば代入や Equals の検査で型エラーになる。
import { addPlugin, type ResourceInfo, type ResourceType, type WeiwudiPlugin } from '../../dist/weiwudi_gw';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(_v?: T): void => undefined;

// ResourceType は 6 値ちょうど
assertType<Equals<ResourceType, 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data'>>();

// ResourceInfo の各項目の型（保存の項目を持たない）
assertType<Equals<ResourceInfo, {
  id: string; type: ResourceType; templates: string[];
  count: number; bytes: number;
  rangeOnly?: true; corsless?: true;
}>>();

const useInfo = (r: ResourceInfo): [string, ResourceType, string[], number, number, true | undefined, true | undefined] =>
  [r.id, r.type, r.templates, r.count, r.bytes, r.rangeOnly, r.corsless];
void useInfo;

// addPlugin は WeiwudiPlugin を受けて void
assertType<Equals<typeof addPlugin, (plugin: WeiwudiPlugin) => void>>();

// 5 つのフックを実装する値
const plugin: WeiwudiPlugin = {
  async requestWillFetch({ request, resource, state }) {
    const s: unknown = state;
    void s;
    const id: string = resource.id;
    void id;
    return new Request(request.url, { headers: { 'x-trace': '1' } });
  },
  async fetchDidSucceed({ response, resource }) {
    const t: ResourceType = resource.type;
    void t;
    return response;
  },
  async fetchDidFail({ error, request }) {
    const e: unknown = error;
    const r: Request = request;
    void e;
    void r;
  },
  async cacheWillUpdate({ response }) {
    return response.ok ? response : null;
  },
  async cachedResponseWillBeUsed({ cachedResponse }) {
    return cachedResponse;
  },
};

// すべて省略可
const empty: WeiwudiPlugin = {};

addPlugin(plugin);
addPlugin(empty);

// フックの引数の形（resource は ResourceInfo）
type RWF = NonNullable<WeiwudiPlugin['requestWillFetch']>;
assertType<Equals<Parameters<RWF>[0], { request: Request; resource: ResourceInfo; state: unknown }>>();
assertType<Equals<ReturnType<RWF>, Promise<Request | void>>>();
type CWU = NonNullable<WeiwudiPlugin['cacheWillUpdate']>;
assertType<Equals<Parameters<CWU>[0], { request: Request; response: Response; resource: ResourceInfo }>>();
assertType<Equals<ReturnType<CWU>, Promise<Response | null | void>>>();
type CRWBU = NonNullable<WeiwudiPlugin['cachedResponseWillBeUsed']>;
assertType<Equals<Parameters<CRWBU>[0], { request: Request; cachedResponse: Response; resource: ResourceInfo }>>();
assertType<Equals<ReturnType<CRWBU>, Promise<Response | null | void>>>();
type FDS = NonNullable<WeiwudiPlugin['fetchDidSucceed']>;
assertType<Equals<Parameters<FDS>[0], { request: Request; response: Response; resource: ResourceInfo; state: unknown }>>();
assertType<Equals<ReturnType<FDS>, Promise<Response | void>>>();
type FDF = NonNullable<WeiwudiPlugin['fetchDidFail']>;
assertType<Equals<Parameters<FDF>[0], { request: Request; error: unknown; resource: ResourceInfo; state: unknown }>>();
assertType<Equals<ReturnType<FDF>, Promise<void>>>();

// @ts-expect-error 知らないフックの名前は書けない（余分な項目）
const wrong: WeiwudiPlugin = { resourceWillRegister: async () => undefined };
void wrong;
