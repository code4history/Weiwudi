"use strict";
import { WeiwudiError, isCodeFormat, legacyMessage, type WeiwudiErrorCode } from './errors';
import { absolutizeTemplate } from './url_pattern';
import { PSEUDO_HOST, V2_PREFIX } from './constants';
import type { Credentials, OutOfRange, ResourceInfo, ResourceType } from './store';
import type { CommonPolicy, FetchRangeOptions, RangeSpec, RegionInfo, SourceSpec } from './spec';
import type { TileBox } from './tile_math';

// 旧 API は文字列で reject し続ける（仕様 §9）。WeiwudiError.from(e) で code を得られる（#33）
export { WeiwudiError, type WeiwudiErrorCode, type TileFailure } from './errors';

// 新 API の公開の型（仕様 §12。名前つきで export する。第 1 回 C4・第 2 回 D3）。ResourceMeta は公開しない（第 1 回 C5）
export type { CommonPolicy, Credentials, OutOfRange, ResourceInfo, ResourceType, SourceSpec, TileBox };
// 範囲取得の型（m4-t3・§7.2・§12）
export type { FetchRangeOptions, RangeSpec, RegionInfo };

/** 登録した Source の公開の形（仕様 §12） */
export interface SourceInfo {
    id: string;
    kind: SourceSpec['kind'];
    url: string | string[];
    /** 呼び出し時点の写し */
    resources: ResourceInfo[];
    /** 登録・update の時点の写し */
    warnings: string[];
}

/** Source の統計（仕様 §12） */
export interface SourceStats {
    count: number;
    size: number;
    /** 範囲が決まるときだけ */
    total?: number;
    /** 同上 */
    percent?: number;
    byResource: Record<string, { count: number; bytes: number }>;
}

/**
 * 全体と提供元別の使用量（仕様 §12・#38。m3-t8）。全 Resource（旧 API の地図も）を 1 回ずつ数える。
 * byProvider の鍵は Resource の提供元（'mapbox' など）、無ければ先頭のテンプレートの origin。null プロトタイプ
 */
export interface UsageReport {
    count: number;
    bytes: number;
    byProvider: Record<string, { count: number; bytes: number }>;
}

const BASEURL = `https://${PSEUDO_HOST}/api/`;
let swChecking: Promise<boolean> | undefined;
let swChecked: boolean | undefined;

// ---- 新 API の確認（ensureV2。仕様 §4.1。swCheck と別の関数で、旧 API の結果に触らない。第 1 回 C2） ----
// モジュール変数に置く理由: ページの 1 つの module 実例を使うのは 1 つのページだけ（module-state.test.ts の除外の理由と同じ）

const V2URL = `https://${PSEUDO_HOST}${V2_PREFIX}`;
/** HTTP キャッシュの 200 を成功と取り違えず、リダイレクトで本文を別オリジンへ移さない（PR #80） */
const V2_FETCH: Readonly<RequestInit> = Object.freeze({ cache: 'no-store', redirect: 'error' });
/** ping が成功した controller の実体（controllerchange で捨てる。第 2 回 D2） */
let v2Verified = new WeakMap<ServiceWorker, true>();
/** 進行中の確認（同時の呼び出しを ping 1 本にまとめる。第 3 回 推奨） */
let v2Pending: Promise<void> | undefined;
let v2Listening = false;

const notControlling = (message: string): WeiwudiError => new WeiwudiError('sw-not-controlling', message);
const outdated = (message: string): WeiwudiError => new WeiwudiError('sw-outdated', message);

const controllerOf = (): ServiceWorker | null =>
    typeof navigator !== 'undefined' && navigator.serviceWorker ? navigator.serviceWorker.controller : null;

/** GET /v2/ping を 1 回。成功は 200 で JSON が { api: 2, version: 空でない文字列 } のときだけ（fail-closed） */
const pingOnce = async (): Promise<void> => {
    let res: Response;
    try {
        res = await fetch(`${V2URL}ping`, { ...V2_FETCH });
    } catch (_e) {
        throw notControlling('The service worker did not answer /v2/ping');
    }
    if (res.status === 404) throw outdated('The service worker does not provide the new API (/v2/ping is 404)');
    if (res.status !== 200) throw notControlling(`The service worker answered /v2/ping with status ${res.status}`);
    let body: unknown;
    try {
        body = await res.json();
    } catch (_e) {
        throw outdated('The service worker answered /v2/ping with an unexpected body');
    }
    const b = body as { api?: unknown; version?: unknown } | null;
    if (!b || typeof b !== 'object' || b.api !== 2 || typeof b.version !== 'string' || b.version === '') {
        throw outdated('The service worker answered /v2/ping with an unexpected body');
    }
};

/**
 * ping の前と後で controller の実体を比べ、違えば 1 回だけ確かめ直す。なお違えば sw-not-controlling（第 3 回 M2）。
 * ping が失敗したときも比べる: 替わっていれば失敗は前の controller のものなので確かめ直し、替わっていなければ
 * その失敗を返す（PR #80 水準 2 必須）
 */
const verify = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
        const before = controllerOf();
        if (!before) throw notControlling('This page is not controlled by a service worker');
        let failure: unknown;
        let failed = false;
        try {
            await pingOnce();
        } catch (e) {
            failed = true;
            failure = e;
        }
        if (controllerOf() !== before) continue;
        if (failed) throw failure;
        v2Verified.set(before, true);
        return;
    }
    throw notControlling('The controlling service worker changed while checking /v2/ping');
};

/**
 * 新 API の確認（仕様 §4.1）。すべての POST の前に通す。controller が無ければ何も送らずに sw-not-controlling。
 * 成功はその controller の実体に結び付けて記憶し、失敗は記憶しない（次の呼び出しで確かめ直す）
 */
const ensureV2 = async (): Promise<void> => {
    const controller = controllerOf();
    if (!controller) throw notControlling('This page is not controlled by a service worker');
    if (!v2Listening) {
        v2Listening = true;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            v2Verified = new WeakMap();
            v2Pending = undefined;
        });
    }
    // 進行中の確認を待った後、今の controller が確認済みかを見直す。替わっていれば 1 回だけ確かめ直す（水準 1 Minor 6）
    for (let round = 0; round < 2; round++) {
        const current = controllerOf();
        if (!current) throw notControlling('This page is not controlled by a service worker');
        if (v2Verified.has(current)) return;
        if (!v2Pending) {
            const p = verify();
            v2Pending = p;
            const done = () => {
                if (v2Pending === p) v2Pending = undefined;
            };
            p.then(done, done);
        }
        await v2Pending;
    }
    const last = controllerOf();
    if (!last || !v2Verified.has(last)) throw notControlling('The controlling service worker changed while checking /v2/ping');
};

/** POST /v2/<op>（text/plain;charset=UTF-8 の JSON。preflight の要らない単純要求。第 1 回 C1）。失敗は WeiwudiError */
const postV2 = async <T>(op: string, body: unknown): Promise<T> => {
    await ensureV2();
    let res: Response;
    try {
        res = await fetch(`${V2URL}${op}`, {
            ...V2_FETCH,
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(body),
        });
    } catch (_e) {
        throw notControlling(`The service worker did not answer /v2/${op}`);
    }
    let reply: { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; detail?: unknown } };
    try {
        reply = await res.json();
    } catch (_e) {
        throw new WeiwudiError('internal', `The service worker answered /v2/${op} with an unexpected body`);
    }
    if (reply && reply.ok === true) return reply.result as T;
    const e = reply && typeof reply.error === 'object' && reply.error !== null ? reply.error : {};
    const detail = e.detail !== null && typeof e.detail === 'object' && Object.keys(e.detail).length > 0
        ? e.detail as Record<string, unknown> : undefined;
    // 新しい SW が増やした code もそのまま渡す（code は minor で増える）。書式に合わない code は internal（m3-t8 i-1）
    throw new WeiwudiError(
        (isCodeFormat(e.code) ? e.code : 'internal') as WeiwudiErrorCode,
        typeof e.message === 'string' ? e.message : `/v2/${op} failed`,
        detail,
    );
};

/** 相対の url をページの場所で絶対化する（仕様 §4.2。字句は符号化しない） */
const absolutizeSpec = (spec: SourceSpec): SourceSpec => {
    if (spec === null || typeof spec !== 'object') return spec;
    const base = typeof location !== 'undefined' ? location.href : undefined;
    if (base === undefined) return spec;
    // スキームのある URL はそのまま（new URL を通すと大文字のホストなどの綴りが変わる）
    const abs = (u: unknown) => (typeof u === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(u) ? absolutizeTemplate(u, base) : u);
    const url = (spec as { url?: unknown }).url;
    return { ...spec, url: Array.isArray(url) ? url.map(abs) : abs(url) } as SourceSpec;
};

/** 範囲取得の待ちで、イベントが来ないときに job/resume を送るまでの時間（§7.2。U3） */
const RESUME_AFTER_MS = 30_000;
/**
 * 覚えておく終わりのメッセージの数。fetchRange の待ちと cancel() の待ちが同じメッセージを読むので、使っても消さず、
 * 古いものから上限を超えた分と release() で捨てる（PR #102 M1・L5）
 */
const ENDED_LIMIT = 64;

/** SW から届く範囲取得のメッセージ（{ type, sourceId, regionId, … }。I5c） */
interface JobMessage {
    type: string;
    regionId?: unknown;
    code?: unknown;
    message?: unknown;
    error?: unknown;
}

const isTerminal = (type: string): boolean => type === 'finish' || type === 'stop' || type === 'canceled';

const stopErrorOf = (code: unknown, message: unknown): WeiwudiError =>
    new WeiwudiError((isCodeFormat(code) ? code : 'internal') as WeiwudiErrorCode,
        typeof message === 'string' ? message : 'The range fetching stopped');

// Polyfill removed as target is ES2020

export class WeiwudiEventTarget {
    listeners: Record<string, ((...args: unknown[]) => void)[]>;

    constructor() {
        this.listeners = {};
    }

    addEventListener(type: string, callback: (...args: unknown[]) => void) {
        if (!(type in this.listeners)) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(callback);
    }

    removeEventListener(type: string, callback: (...args: unknown[]) => void) {
        if (!(type in this.listeners)) {
            return;
        }
        const stack = this.listeners[type];
        for (let i = 0, l = stack.length; i < l; i++) {
            if (stack[i] === callback) {
                stack.splice(i, 1);
                return;
            }
        }
    }

    dispatchEvent(event: Event | CustomEvent) {
        if (!(event.type in this.listeners)) {
            return true;
        }
        const stack = this.listeners[event.type].slice();

        for (let i = 0, l = stack.length; i < l; i++) {
            stack[i].call(this, event);
        }
        return !event.defaultPrevented;
    }
}

export interface WeiwudiOptions {
    type?: string;
    url?: string;
    width?: number;
    height?: number;
    tileSize?: number;
    minZoom?: number;
    maxZoom?: number;
    maxLng?: number;
    maxLat?: number;
    minLng?: number;
    minLat?: number;
    // タイルキャッシュの有効期間(ms)。未指定は24時間 (#2)
    cacheTtl?: number;
    // キャッシュ容量の上限(byte)。未指定は上限なし (#29)
    cacheMaxBytes?: number;
    [key: string]: unknown;
}

export interface WeiwudiInternalOps {
    // Placeholder for future strict typing of internal operations
    [key: string]: unknown;
}

/**
 * 新 API で登録した Source（仕様 §12）。resources と warnings は呼び出し時点の写しで、後の変化は stats() か
 * Weiwudi.source() で読み直す（update() はこの実例の写しを update の時点のものに置き換える）
 */
export class WeiwudiSource extends WeiwudiEventTarget {
    readonly id: string;
    /** 地図ライブラリへ渡す実 URL（資格情報なし） */
    readonly url: string | string[];
    readonly resources: ResourceInfo[];
    readonly warnings: string[];
    private released = false;
    private readonly listener: (e: MessageEvent) => void;
    /** 範囲取得の待ち（メッセージを受ける関数） */
    private readonly waiters = new Set<(data: JobMessage) => void>();
    /** release() で待ちを止める関数 */
    private readonly releasers = new Set<() => void>();
    /** 届いた終わりのメッセージ（regionId → メッセージ。POST の応答より先に届いたものを取りこぼさない） */
    private readonly ended = new Map<string, JobMessage>();

    constructor(info: SourceInfo) {
        super();
        this.id = info.id;
        this.url = Array.isArray(info.url) ? info.url.slice() : info.url;
        this.resources = info.resources.map((r) => ({ ...r, templates: r.templates.slice() }));
        this.warnings = info.warnings.slice();
        this.listener = (e: MessageEvent) => {
            const data = e.data as { sourceId?: unknown; type?: unknown } | null;
            if (!data || data.sourceId !== this.id || typeof data.type !== 'string') return;
            const job = data as JobMessage;
            if (typeof job.regionId === 'string' && isTerminal(job.type)) {
                this.ended.set(job.regionId, job);
                // 古いものから上限を超えた分を捨てる（region の id は毎回新しいので、同じ id の待ちは後から来ない）
                for (const k of this.ended.keys()) {
                    if (this.ended.size <= ENDED_LIMIT) break;
                    this.ended.delete(k);
                }
            }
            for (const w of [...this.waiters]) w(job);
            this.dispatchEvent(new CustomEvent(data.type, { detail: data }));
        };
        navigator.serviceWorker?.addEventListener('message', this.listener);
    }

    private alive(): void {
        if (this.released) throw new WeiwudiError('instance-released', legacyMessage('instance-released'));
    }

    async stats(): Promise<SourceStats> {
        this.alive();
        return postV2<SourceStats>('stats', { id: this.id });
    }

    /** 保存した登録内容で合流と方針を作り直し、CORS の判定をやり直す。自分自身の衝突は resource-conflict で reject */
    async update(): Promise<void> {
        this.alive();
        const info = await postV2<SourceInfo>('update', { id: this.id });
        (this as { resources: ResourceInfo[] }).resources = info.resources;
        (this as { warnings: string[] }).warnings = info.warnings;
    }

    /** 排他の Entry を消す。範囲ありはタイルだけで固定を残し、force で固定も消して重なる自分の region を partial にする */
    async clean(range?: RangeSpec, opts?: { force?: boolean }): Promise<void> {
        this.alive();
        await postV2<null>('clean', { id: this.id, range, options: opts });
    }

    /** region を解放する。keep または共有の Resource なら本体は残す。他の固定つき region の分は保つ */
    async releaseRange(regionId: string, opts: { keep?: boolean } = {}): Promise<void> {
        this.alive();
        await postV2<null>('releaseRange', { id: this.id, regionId, options: opts });
    }

    /**
     * その Source（スタイルは子）の Resource の Entry を消す（#38）。共有・範囲だけの参照でも消す（clean() は共有を残す）。
     * Resource の記録と捕捉は残る（次の要求は取り直して保存する）。無ければ resource-not-found
     */
    async removeResource(resourceId: string): Promise<void> {
        this.alive();
        await postV2<null>('removeResource', { id: this.id, resourceId });
    }

    /** 登録と Entry を消し、ページ側のリスナを外す */
    async remove(): Promise<void> {
        this.alive();
        await postV2<null>('remove', { id: this.id });
        this.release();
    }

    /** タイルの枚数（§7.2。非タイルの資源は数えない。R29） */
    async estimate(range: RangeSpec): Promise<{ tiles: number }> {
        this.alive();
        return postV2<{ tiles: number }>('estimate', { id: this.id, range });
    }

    /**
     * 範囲を取得して固定する（§7.2）。持続的な保存領域を求め（失敗は無視。I5b）、ratio の既定は devicePixelRatio > 1 なら
     * '@2x'（R-ratio）。終わり（finish・canceled は resolve、stop は WeiwudiError で reject）まで待つ。30 秒イベントが来なければ
     * job/resume を送る（R22・R45）
     */
    async fetchRange(range: RangeSpec, opts: FetchRangeOptions = {}): Promise<RegionInfo> {
        this.alive();
        try {
            await navigator.storage?.persist?.();
        } catch (_e) {
            // 持続化を断られても取得は続ける
        }
        const ratio = opts.ratio ?? (typeof devicePixelRatio === 'number' && devicePixelRatio > 1 ? '@2x' : '');
        const info = await postV2<RegionInfo>('fetchRange', { id: this.id, range, options: { ...opts, ratio } });
        if (info.status === 'stopped') throw stopErrorOf(info.code, undefined);
        if (info.status !== 'running') return info;
        return this.waitRegion(info);
    }

    /** この Source の region の一覧（§12）。SW が止まって running のままのものは partial（R5） */
    async regions(): Promise<RegionInfo[]> {
        this.alive();
        return postV2<RegionInfo[]>('regions', { id: this.id });
    }

    /**
     * この Source の取得を止める。取り消したジョブの canceled（か終わりのイベント）を受けてから解決する（30 秒来なければ
     * regions() を読んで解決する。R58・第 2 回 M4）。旧 API のジョブなど regionId が無ければすぐ解決。無ければ no-fetch-process
     */
    async cancel(): Promise<void> {
        this.alive();
        const r = await postV2<{ regionId: string | null } | null>('cancel', { id: this.id });
        const regionId = r && typeof r.regionId === 'string' ? r.regionId : undefined;
        if (regionId === undefined) return;
        await new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let done = false;
            const end = (fn: () => void) => {
                if (done) return;
                done = true;
                if (timer !== undefined) clearTimeout(timer);
                this.waiters.delete(onMessage);
                this.releasers.delete(onRelease);
                fn();
            };
            const onMessage = (data: JobMessage) => {
                if (data.regionId === regionId && isTerminal(data.type)) end(resolve);
            };
            const onRelease = () => end(() => reject(new WeiwudiError('instance-released', legacyMessage('instance-released'))));
            this.waiters.add(onMessage);
            this.releasers.add(onRelease);
            if (this.ended.has(regionId)) {
                end(resolve);
                return;
            }
            timer = setTimeout(() => {
                // SW が止まっていれば ctx.job も無い。regions() を読めたら解決する
                this.regions().then(() => end(resolve), (e: unknown) => end(() => reject(e)));
            }, RESUME_AFTER_MS);
        });
    }

    /** fetchRange の待ち（R22・R45）。終わりのメッセージ・job/resume の終わりの status・release() のどれかで決まる */
    private waitRegion(info: RegionInfo): Promise<RegionInfo> {
        return new Promise<RegionInfo>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let done = false;
            const end = (fn: () => void) => {
                if (done) return;
                done = true;
                if (timer !== undefined) clearTimeout(timer);
                this.waiters.delete(onMessage);
                this.releasers.delete(onRelease);
                fn();
            };
            /** finish・canceled の後は regions() の記録で解決する（無ければ受けたメッセージから作る） */
            const resolveFrom = (status: RegionInfo['status']) => end(() => {
                this.regions().then((list) => {
                    resolve(list.find((r) => r.id === info.id) ?? { ...info, status });
                }, reject);
            });
            const terminal = (data: JobMessage) => {
                if (data.type === 'stop') end(() => reject(stopErrorOf(data.code, data.message)));
                else if (data.type === 'canceled') resolveFrom('canceled');
                else resolveFrom(typeof data.error === 'number' && data.error > 0 ? 'partial' : 'complete');
            };
            const resume = () => {
                postV2<RegionInfo>('job/resume', { id: this.id, regionId: info.id }).then((r) => {
                    if (done) return;
                    if (r.status === 'running') arm();
                    else if (r.status === 'stopped') end(() => reject(stopErrorOf(r.code, undefined)));
                    else end(() => resolve(r));
                }, (e: unknown) => end(() => reject(e)));
            };
            const arm = () => {
                if (timer !== undefined) clearTimeout(timer);
                timer = setTimeout(resume, RESUME_AFTER_MS);
            };
            const onMessage = (data: JobMessage) => {
                if (data.regionId !== info.id) return;
                if (isTerminal(data.type)) terminal(data);
                else arm();
            };
            const onRelease = () => end(() => reject(new WeiwudiError('instance-released', legacyMessage('instance-released'))));
            this.waiters.add(onMessage);
            this.releasers.add(onRelease);
            const early = this.ended.get(info.id);
            if (early) terminal(early);
            else arm();
        });
    }

    /** ページ側のリスナを外す（以後のメソッドは instance-released で reject。範囲取得の待ちも reject する） */
    release(): void {
        if (this.released) return;
        this.released = true;
        navigator.serviceWorker?.removeEventListener('message', this.listener);
        for (const f of [...this.releasers]) f();
        this.ended.clear();
    }
}

export default class Weiwudi extends WeiwudiEventTarget {
    mapID?: string;
    url?: string;
    listener: (e: MessageEvent) => void;

    static async registerSW(sw: string | URL, swOptions?: RegistrationOptions) {
        if (!('serviceWorker' in navigator)) {
            throw (legacyMessage('sw-unsupported'));
        }
        let reg: ServiceWorkerRegistration;
        try {
            reg = await navigator.serviceWorker.register(sw, swOptions);
        } catch (e) {
            throw (legacyMessage('sw-register-failed', { error: `${e}` }));
        }
        // 初回ナビゲーションをリロードせずに SW の制御下へ置くため、
        // ready + controller 取得を上限付きで待つ（#30）
        await Weiwudi.waitForController();
        await Weiwudi.swCheck();
        return reg;
    }

    static async waitForController(): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;

            function finish() {
                if (settled) return;
                settled = true;
                if (timeout !== undefined) clearTimeout(timeout);
                navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
            }

            function onControllerChange() {
                if (navigator.serviceWorker.controller) {
                    finish();
                    resolve();
                }
            }

            navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
            timeout = setTimeout(() => {
                finish();
                reject(legacyMessage('sw-not-controlling'));
            }, 10000);
            navigator.serviceWorker.ready.then(() => {
                if (navigator.serviceWorker.controller) {
                    finish();
                    resolve();
                }
            }).catch(() => {
                // ready が解決しない構成（scope 外 page など）では controllerchange も発火せず、
                // 上限時間で reject される
            });
        });
    }

    static async swCheck() {
        if (swChecked !== undefined) return swChecked;
        if (swChecking === undefined) swChecking = new Promise((res, _rej) => {
            // Removing async from executor and handling promise explicitly if needed, 
            // but here the code was wrapping await in a new Promise which is antipattern.
            // We can just rely on correct async flow or keep simpler.
            // Given logic:
            fetch(`${BASEURL}ping`)
                .then(r => {
                    swChecked = !!r;
                    res(swChecked);
                })
                .catch(_e => {
                    swChecked = false;
                    res(swChecked);
                });
        });
        return swChecking;
    }

    /**
     * 新 API の登録（仕様 §12）。資源の衝突では失敗せず warnings に書く（§5.6）。register の完了を待ってから
     * 地図を作る（先に作ると最初の要求が捕捉されない）
     */
    static async register(spec: SourceSpec): Promise<WeiwudiSource> {
        const abs = absolutizeSpec(spec);
        return new WeiwudiSource(await postV2<SourceInfo>('register', abs));
    }

    /** 登録済みの Source。無ければ source-not-found（旧 API の地図も） */
    static async source(id: string): Promise<WeiwudiSource> {
        return new WeiwudiSource(await postV2<SourceInfo>('source', { id }));
    }

    /** 全体と提供元別の使用量（#38）。byProvider は null プロトタイプ（鍵が __proto__ でも自前の項目） */
    static async usage(): Promise<UsageReport> {
        const r = await postV2<UsageReport>('usage', {});
        const byProvider: UsageReport['byProvider'] = Object.create(null);
        const src = r && typeof r.byProvider === 'object' && r.byProvider !== null ? r.byProvider : {};
        for (const key of Object.keys(src)) {
            const v = src[key];
            byProvider[key] = { count: v.count, bytes: v.bytes };
        }
        return { count: r.count, bytes: r.bytes, byProvider };
    }

    /** 新 API で登録した Source の一覧（旧 API の地図は含まない） */
    static async sources(): Promise<SourceInfo[]> {
        return postV2<SourceInfo[]>('sources', {});
    }

    static async registerMap(mapID: string, options: WeiwudiOptions) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw (legacyMessage('sw-not-implemented'));
        let text;
        const p = ['type', 'url', 'width', 'height', 'tileSize', 'minZoom', 'maxZoom', 'maxLng', 'maxLat', 'minLng', 'minLat', 'cacheTtl', 'cacheMaxBytes'].reduce((p, key) => {
            if (typeof options[key] !== 'undefined') {
                if (options[key] instanceof Array) {
                    options[key].map((val: string) => {
                        p.append(key, val);
                    });
                } else {
                    p.append(key, String(options[key]));
                }
            }
            return p;
        }, new URLSearchParams());
        p.append('mapID', mapID);
        const url = new URL(`${BASEURL}add`);
        url.search = p.toString(); // URLSearchParams to string
        const res = await fetch(url.href);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
        return new Weiwudi(mapID, JSON.parse(text));
    }

    static async retrieveMap(mapID: string) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw (legacyMessage('sw-not-implemented'));
        let text;
        const res = await fetch(`${BASEURL}info?mapID=${mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
        console.log(text);
        return new Weiwudi(mapID, JSON.parse(text));
    }

    static async removeMap(mapID: string) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw (legacyMessage('sw-not-implemented'));
        let text;
        const res = await fetch(`${BASEURL}delete?mapID=${mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }

    constructor(mapID: string, attrs?: WeiwudiOptions) {
        super();
        if (!mapID) throw (legacyMessage('map-id-required'));
        this.mapID = mapID;
        if (attrs) Object.assign(this, attrs);
        this.url = `${BASEURL}cache/${mapID}/{z}/{x}/{y}`;
        this.listener = (e: MessageEvent) => {
            const eventMapID = e.data.mapID;
            if (eventMapID !== mapID) return;
            this.dispatchEvent(new CustomEvent(e.data.type, { detail: e.data }));
        };
        navigator.serviceWorker.addEventListener('message', this.listener);
    }

    release() {
        navigator.serviceWorker.removeEventListener('message', this.listener);
        delete this.mapID;
    }

    checkAspect() {
        if (!this.mapID) throw (legacyMessage('instance-released'));
    }

    async stats() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}stats?mapID=${this.mapID}`);
        text = await res.text();
        if (typeof text === 'string' && text.match(/^Error: /)) {
            throw (text);
        }
        return JSON.parse(text);
    }

    async clean() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}clean?mapID=${this.mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }

    async fetchAll() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}fetchAll?mapID=${this.mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }

    async remove() {
        this.checkAspect();
        if (this.mapID) await Weiwudi.removeMap(this.mapID);
        this.release();
    }

    async cancel() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}cancel?mapID=${this.mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }
}