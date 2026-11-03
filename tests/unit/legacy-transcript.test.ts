// 旧 API の突き合わせ（golden。m2-t5・仕様 §13・計画「突き合わせ」）。
// 旧実装（載せ替えの前）で UPDATE_GOLDEN=1 のときだけ __golden__/legacy-transcript.json を書き出す。
// UPDATE_GOLDEN が無ければ golden を読んで比べ、golden が無ければ失敗する。golden を直してはならない。
//
// 決まり（計画の 1〜9）:
// - 筋書きの URL はすべて絶対 URL
// - 偽の時計は Date だけ。Math.random は固定の列（ミラーの選択を決める）
// - 記録: 各手の status・statusText・全ヘッダ（小文字・名前順・同名は結合）・本文（JSON は parse）、
//   postMessage の列、上流の fetch の呼び出し（URL と引数の数）
// - 比べないヘッダは x-weiwudi-status と access-control-expose-headers の 2 つだけ
// - 仕様 §9 の既知の変化に当たる手は入れない（未登録の地図の clean・200 の text/html・落とす 4 ヘッダ・blocked の DB 名）
// - 上流の偽の応答には落とす 4 ヘッダ（content-encoding など）と x-weiwudi-* を入れない
// - ミラーの地図には上流へ出る手（miss）だけを入れる（ミラーの選択は上流へ出るときの 1 回の無作為）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createSwHarness, tileResponse } from './sw-harness';

const GOLDEN = fileURLToPath(new URL('./__golden__/legacy-transcript.json', import.meta.url));
const IGNORED_HEADERS = ['x-weiwudi-status', 'access-control-expose-headers'];
const MIN_STEPS = 60;
const T0 = 1_760_000_000_000;
const RANDOM_SEQ = [0.1, 0.9, 0.5, 0.4, 0.7, 0.2, 0.95, 0.05];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Body = { json: unknown } | { text: string } | { base64: string };
interface Recorded {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Body;
}
interface Step {
  step: number;
  label: string;
  request?: string;
  client?: boolean;
  response?: Recorded;
  fetches: { url: string; args: number }[];
  messages: unknown[];
}

const decodeBody = (bytes: Uint8Array, contentType: string): Body => {
  if (contentType.includes('json')) return { json: JSON.parse(new TextDecoder().decode(bytes)) };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(text)) return { text };
  } catch (_e) {
    // 文字にならない本体は base64 で記録する
  }
  return { base64: Buffer.from(bytes).toString('base64') };
};

const record = async (res: Response): Promise<Recorded> => {
  const pairs: [string, string][] = [];
  res.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (IGNORED_HEADERS.indexOf(n) < 0) pairs.push([n, value]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headers: Record<string, string> = {};
  for (const [n, v] of pairs) headers[n] = headers[n] === undefined ? v : `${headers[n]}, ${v}`;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, statusText: res.statusText, headers, body: decodeBody(bytes, headers['content-type'] ?? '') };
};

/** 上流の偽物。ホストごとに振る舞いを決める（4 ヘッダと x-weiwudi-* は付けない） */
const makeUpstream = () => {
  let seq = 0;
  const state = {
    flaky: 'ok' as 'ok' | '500' | 'down' | 'created',
    gate: undefined as undefined | { promise: Promise<void>; release: () => void },
  };
  const openGate = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    state.gate = { promise, release };
  };
  const impl = async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const u = new URL(url);
    switch (u.host) {
      case 'ok.example':
        return new Response(`ok:${u.pathname}`, { headers: { 'content-type': 'image/png', 'x-tile': u.pathname } });
      case 'seq.example':
        return new Response(`body-${++seq}`, { headers: { 'content-type': 'image/png' } });
      case 'bin.example': {
        const x = Number(u.pathname.split('/')[3]);
        return tileResponse(x === 3 ? 21 : 10);
      }
      case 'a.example':
      case 'b.example':
      case 'c.example':
        return new Response(`mirror:${u.host}${u.pathname}`, { headers: { 'content-type': 'image/jpeg' } });
      case 'flaky.example':
        if (state.flaky === 'down') throw new TypeError('network down');
        if (state.flaky === '500') {
          return new Response('boom', { status: 500, statusText: 'Internal Server Error', headers: { 'x-upstream': 'err', 'retry-after': '5' } });
        }
        if (state.flaky === 'created') {
          return new Response(`created:${u.pathname}`, { status: 201, statusText: 'Created', headers: { 'content-type': 'image/png' } });
        }
        return new Response(`flaky:${u.pathname}:${++seq}`, {
          headers: { 'content-type': 'image/png', 'cache-control': 'max-age=60', 'x-custom': 'yes' },
        });
      case 'mix.example':
        if (u.pathname === '/fa/2/1/1.png') throw new TypeError('network down');
        if (u.pathname === '/fa/2/2/2.png') return new Response('boom', { status: 500 });
        return tileResponse(4);
      case 'gate.example':
        if (state.gate) await state.gate.promise;
        return tileResponse(3);
      default:
        throw new TypeError(`unexpected upstream ${url}`);
    }
  };
  return { state, impl, openGate };
};

const enc = (s: string) => encodeURIComponent(s);

const runScenario = async (): Promise<Step[]> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  let r = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => RANDOM_SEQ[r++ % RANDOM_SEQ.length]);

  const h = createSwHarness();
  const up = makeUpstream();
  h.fetch.mockImplementation(up.impl);
  const client = { id: 'client-1', postMessage: vi.fn() };
  h.self.clients.get.mockResolvedValue(client);

  const steps: Step[] = [];
  let fetchSeen = 0;
  let msgSeen = 0;
  const drain = () => {
    const fetches = h.fetch.mock.calls.slice(fetchSeen).map((args) => ({
      url: typeof args[0] === 'string' ? args[0] : (args[0] as Request).url,
      args: args.length,
    }));
    // ジョブの中は 5 本が並行なので、呼び出しの順は比べない
    fetches.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.args - b.args));
    fetchSeen = h.fetch.mock.calls.length;
    const messages = client.postMessage.mock.calls.slice(msgSeen).map(([m]) => structuredClone(m));
    msgSeen = client.postMessage.mock.calls.length;
    return { fetches, messages };
  };
  const at = (dt: number) => vi.setSystemTime(T0 + dt);

  const req = async (label: string, path: string, opts: { client?: boolean } = {}) => {
    const res = opts.client ? await h.requestFromClient(path, client) : await h.request(path);
    const response = await record(res);
    steps.push({ step: steps.length + 1, label, request: path, ...(opts.client ? { client: true } : {}), response, ...drain() });
  };
  const waitMessages = async (label: string, done: (all: { type: string }[]) => boolean) => {
    await vi.waitFor(() => {
      const all = client.postMessage.mock.calls.slice(msgSeen).map(([m]) => m as { type: string });
      expect(done(all)).toBe(true);
    }, { timeout: 5000, interval: 2 });
    steps.push({ step: steps.length + 1, label, ...drain() });
  };
  const add = (mapID: string, type: string, urls: string[], extra = '') =>
    `/api/add?mapID=${mapID}&type=${type}${urls.map((u) => `&url=${enc(u)}`).join('')}${extra}`;

  // ---- 入口と属性 ----
  await req('ping', '/api/ping');
  await req('api でないパス', '/foo');
  await req('未知の API', '/api/nope');
  await req('info の mapID の欠け', '/api/info');
  await req('add の mapID の欠け', '/api/add');
  await req('add の type の欠け', '/api/add?mapID=m');
  await req('add の url の欠け', '/api/add?mapID=m&type=xyz');
  await req('add の未知の type', add('m', 'zzz', ['https://ok.example/m/{z}/{x}/{y}.png']));
  await req('add xyz の width の欠け', add('m', 'xyz', ['https://ok.example/m/{z}/{x}/{y}.png'], '&height=500'));
  await req('stats の mapID の欠け', '/api/stats');
  await req('clean の mapID の欠け', '/api/clean');
  await req('delete の mapID の欠け', '/api/delete');
  await req('cancel の mapID の欠け', '/api/cancel');

  // ---- xyz・cacheTtl ----
  const X1 = ['https://seq.example/x1/{z}/{x}/{y}.png'];
  await req('add xyz（cacheTtl 1000）', add('x1', 'xyz', X1, '&width=1024&height=1024&cacheTtl=1000'));
  await req('info xyz', '/api/info?mapID=x1');
  await req('stats 空', '/api/stats?mapID=x1');
  await req('cache miss', '/api/cache/x1/2/1/0');
  at(500);
  await req('cache hit', '/api/cache/x1/2/1/0');
  at(1000);
  await req('cache hit（ちょうど cacheTtl）', '/api/cache/x1/2/1/0');
  at(1001);
  await req('cache の TTL 切れで取り直し', '/api/cache/x1/2/1/0');
  await req('cache ズームの外（maxZoom より上）', '/api/cache/x1/3/0/0');
  await req('cache 広がりの外', '/api/cache/x1/2/4/0');
  await req('cache 広がりの外（y）', '/api/cache/x1/1/0/2');
  await req('cache の座標の欠け', '/api/cache/x1/1/2');
  await req('cache 未登録の地図', '/api/cache/zz/0/0/0');
  await req('stats 1 枚', '/api/stats?mapID=x1');
  await req('add 同じ地図の登録し直し（cacheTtl を伸ばす）', add('x1', 'xyz', X1, '&width=1024&height=1024&cacheTtl=999999'));
  await req('stats 登録し直しでもキャッシュは残る', '/api/stats?mapID=x1');
  at(5000);
  await req('cache 登録し直しの後の hit', '/api/cache/x1/2/1/0');
  await req('add xyz（tileSize・minZoom）', add('t5', 'xyz', ['https://ok.example/t5/{z}/{x}/{y}.png'], '&width=600&height=300&tileSize=512&minZoom=1'));
  await req('cache minZoom 未満', '/api/cache/t5/0/0/0');
  await req('cache minZoom の miss', '/api/cache/t5/1/1/0');

  // ---- wmts ----
  await req('add wmts（範囲つき）', add('w1', 'wmts', ['https://ok.example/w1/{z}/{x}/{-y}.png'],
    '&minLng=139.7&maxLng=139.8&minLat=35.6&maxLat=35.7&minZoom=10&maxZoom=12'));
  await req('cache wmts の miss（{-y}）', '/api/cache/w1/12/3637/1612');
  await req('cache wmts の minZoom 未満', '/api/cache/w1/9/0/0');
  await req('cache wmts の広がりの外', '/api/cache/w1/12/0/0');
  await req('cache wmts の低いズームの miss', '/api/cache/w1/10/909/403');
  await req('stats wmts', '/api/stats?mapID=w1');
  await req('add wmts（範囲なし）', add('w2', 'wmts', ['https://ok.example/w2/{z}/{x}/{y}.png'], '&minZoom=3&maxZoom=5'));
  await req('cache 範囲なしのズームの外', '/api/cache/w2/2/0/0');
  await req('cache 範囲なしの miss', '/api/cache/w2/4/100/100');
  await req('stats 範囲なし（total なし）', '/api/stats?mapID=w2');
  await req('fetchAll 範囲なし', '/api/fetchAll?mapID=w2', { client: true });

  // ---- cacheMaxBytes ----
  await req('add cacheMaxBytes の誤り', add('mbad', 'xyz', ['https://bin.example/mbad/{z}/{x}/{y}'], '&width=256&height=256&cacheMaxBytes=1.5'));
  await req('info 誤りの地図は保存されない', '/api/info?mapID=mbad');
  await req('add cacheMaxBytes 20', add('mb', 'xyz', ['https://bin.example/mb/{z}/{x}/{y}'], '&width=1024&height=1024&cacheMaxBytes=20'));
  at(10_001);
  await req('cache 容量 1 枚目', '/api/cache/mb/2/0/0');
  at(10_002);
  await req('cache 容量 2 枚目', '/api/cache/mb/2/1/0');
  at(10_003);
  await req('cache 容量 1 枚目の hit（accessedAt を進める）', '/api/cache/mb/2/0/0');
  at(10_004);
  await req('cache 容量 3 枚目（最も古い 2/1/0 を退避）', '/api/cache/mb/2/2/0');
  await req('stats 容量', '/api/stats?mapID=mb');
  at(10_005);
  await req('cache 退避した 2/1/0 の取り直し', '/api/cache/mb/2/1/0');
  at(10_006);
  await req('cache 2/2/0 は残っている', '/api/cache/mb/2/2/0');
  at(10_007);
  await req('cache 上限より大きい 21 バイト', '/api/cache/mb/2/3/0');
  await req('stats 大きい応答は保存しない', '/api/stats?mapID=mb');
  await req('add cacheMaxBytes 0', add('mz', 'xyz', ['https://bin.example/mz/{z}/{x}/{y}'], '&width=256&height=256&cacheMaxBytes=0'));
  await req('cache 上限 0 は配信だけ', '/api/cache/mz/0/0/0');
  await req('stats 上限 0', '/api/stats?mapID=mz');
  await req('info 上限つき', '/api/info?mapID=mb');

  // ---- ミラー（上流へ出る手だけ） ----
  await req('add ミラー 3 つ', add('mir', 'xyz', ['https://a.example/{z}/{x}/{y}', 'https://b.example/{z}/{x}/{y}', 'https://c.example/{z}/{x}/{y}'], '&width=1024&height=1024'));
  await req('info ミラーは配列', '/api/info?mapID=mir');
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1]]) {
    await req(`cache ミラーの miss ${x}/${y}`, `/api/cache/mir/2/${x}/${y}`);
  }

  // ---- 上流の失敗 ----
  at(20_000);
  await req('add 不安定な上流（cacheTtl 1000）', add('fl', 'xyz', ['https://flaky.example/fl/{z}/{x}/{y}.png'], '&width=512&height=512&cacheTtl=1000'));
  up.state.flaky = 'ok';
  await req('cache 上流のヘッダを保つ miss', '/api/cache/fl/1/0/0');
  await req('cache 上流のヘッダを保つ hit', '/api/cache/fl/1/0/0');
  at(25_000);
  up.state.flaky = '500';
  await req('cache 上流 500・Entry あり（古い本体）', '/api/cache/fl/1/0/0');
  up.state.flaky = 'down';
  await req('cache 例外・Entry あり（古い本体）', '/api/cache/fl/1/0/0');
  up.state.flaky = 'ok';
  await req('cache 期限切れの取り直し', '/api/cache/fl/1/0/0');
  up.state.flaky = '500';
  await req('cache 上流 500・Entry なし', '/api/cache/fl/1/1/0');
  up.state.flaky = 'down';
  await req('cache 例外・Entry なし', '/api/cache/fl/1/1/1');
  up.state.flaky = 'created';
  await req('cache 上流 201 は 200 OK', '/api/cache/fl/1/0/1');
  up.state.flaky = 'down';
  await req('cache 201 で保存したものの hit', '/api/cache/fl/1/0/1');
  await req('stats 不安定な上流', '/api/stats?mapID=fl');
  await req('clean', '/api/clean?mapID=fl');
  await req('stats clean の後', '/api/stats?mapID=fl');
  await req('cache clean の後の例外', '/api/cache/fl/1/0/0');
  await req('delete', '/api/delete?mapID=fl');
  await req('info delete の後', '/api/info?mapID=fl');
  await req('stats delete の後', '/api/stats?mapID=fl');
  await req('cache delete の後', '/api/cache/fl/1/0/0');
  await req('delete 未登録', '/api/delete?mapID=never');
  await req('cancel 取得中でない', '/api/cancel?mapID=x1');
  await req('stats 未登録', '/api/stats?mapID=never');
  await req('info 未登録', '/api/info?mapID=never');

  // ---- fetchAll ----
  await req('fetchAll client なし', '/api/fetchAll?mapID=x1');
  await req('fetchAll 未登録', '/api/fetchAll?mapID=never', { client: true });
  await req('fetchAll mapID の欠け', '/api/fetchAll', { client: true });
  await req('add fetchAll 用', add('fa', 'xyz', ['https://mix.example/fa/{z}/{x}/{y}.png'], '&width=1024&height=1024'));
  await req('fetchAll 開始', '/api/fetchAll?mapID=fa', { client: true });
  await waitMessages('fetchAll 完了まで', (all) => all.some((m) => m.type === 'finish'));
  await req('stats fetchAll の後', '/api/stats?mapID=fa');
  await req('fetchAll 2 回目（有るタイルは飛ばす）', '/api/fetchAll?mapID=fa', { client: true });
  await waitMessages('fetchAll 2 回目の完了まで', (all) => all.some((m) => m.type === 'finish'));
  await req('cache fetchAll で取ったタイルの hit', '/api/cache/fa/2/0/0');

  // ---- 取得中の操作と cancel ----
  await req('add 止めて待つ上流', add('g', 'xyz', ['https://gate.example/g/{z}/{x}/{y}.png'], '&width=1024&height=1024'));
  up.openGate();
  await req('fetchAll 止まる取得の開始', '/api/fetchAll?mapID=g', { client: true });
  await vi.waitFor(() => {
    expect(h.fetch.mock.calls.slice(fetchSeen).length).toBe(5);
  }, { timeout: 5000, interval: 2 });
  steps.push({ step: steps.length + 1, label: '最初のバッチの 5 本が上流で止まる', ...drain() });
  await req('fetchAll 取得中の別の地図', '/api/fetchAll?mapID=x1', { client: true });
  await req('clean 取得中', '/api/clean?mapID=g');
  await req('delete 取得中', '/api/delete?mapID=g');
  await req('clean 取得中でない別の地図', '/api/clean?mapID=mz');
  await req('stats 取得中', '/api/stats?mapID=g');
  await req('cancel 取得中', '/api/cancel?mapID=g');
  up.state.gate!.release();
  await waitMessages('cancel が効くまで', (all) => all.some((m) => m.type === 'canceled'));
  await req('cancel の後の cancel', '/api/cancel?mapID=g');
  await req('stats cancel の後', '/api/stats?mapID=g');
  await req('fetchAll cancel の後の再開', '/api/fetchAll?mapID=g', { client: true });
  await waitMessages('再開の完了まで', (all) => all.some((m) => m.type === 'finish'));
  await req('stats 再開の後', '/api/stats?mapID=g');
  await req('delete 取得の後', '/api/delete?mapID=g');
  await req('stats 全体の最後', '/api/stats?mapID=x1');

  return steps;
};

describe('旧 API の突き合わせ（golden・m2-t5）', () => {
  it('筋書きの全手が golden と一致する', async () => {
    const steps = await runScenario();
    expect(steps.length).toBeGreaterThanOrEqual(MIN_STEPS);
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(steps, null, 2)}\n`);
      return;
    }
    expect(existsSync(GOLDEN), `golden が無い: ${GOLDEN}`).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Step[];
    expect(golden.length).toBeGreaterThanOrEqual(MIN_STEPS);
    for (let i = 0; i < Math.max(golden.length, steps.length); i++) {
      expect(steps[i], `手 ${i + 1}: ${golden[i]?.label ?? steps[i]?.label}`).toEqual(golden[i]);
    }
  });
});
