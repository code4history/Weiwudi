// 上流へ送る User-Agent（2026-11-14 の指示）。ページ（registerSW の検査）と SW（組み立て・付ける場面）の両方が import する。
// 値の依存は errors だけ（仕様 §3）。
//
// 決まり:
// - 値はブラウザの User-Agent の後ろに足す（置き換えない）: `${navigator.userAgent} ${指定値} Weiwudi/<version>`。
//   指定が無ければ `${navigator.userAgent} Weiwudi/<version>`。Weiwudi/<version> は指定があっても残す
// - 付けるのは、SW と同じオリジンの URL で mode が cors か same-origin の要求だけ。別オリジンに付けると WebKit が
//   preflight を出して取得が壊れる。no-cors はヘッダが捨てられる。Chromium は同じオリジンでも捨てる（エラーにしない）
// - 要求がすでに User-Agent を持っていれば（差し込み口などが明示したもの）、そのまま送る
// - version は build（vite・vitest の define）が package.json から埋め込む
import { WeiwudiError } from './errors';

declare const __WEIWUDI_VERSION__: string;

/** 指定値の長さの上限 */
export const USER_AGENT_MAX_LENGTH = 200;

/** 常に付ける製品名と版 */
export const weiwudiProduct = (): string => `Weiwudi/${__WEIWUDI_VERSION__}`;

const invalid = (reason: string): WeiwudiError =>
  new WeiwudiError('attribute-invalid', `Attribute "userAgent" ${reason}`, { attribute: 'userAgent' });

/**
 * 指定値を検査し、前後の空白を除いた値を返す。文字列でない・空白だけ・制御文字を含む・印字できる ASCII 以外を含む
 * （ヘッダの値にできない）・長すぎる値は WeiwudiError('attribute-invalid')
 */
export function validateUserAgent(value: unknown): string {
  if (typeof value !== 'string') throw invalid('must be a string');
  const v = value.trim();
  if (v === '') throw invalid('must not be blank');
  if (/[\u0000-\u001f\u007f]/.test(v)) throw invalid('must not contain a control character');
  if (/[^ -~]/.test(v)) throw invalid('must contain only printable ASCII characters');
  if (v.length > USER_AGENT_MAX_LENGTH) throw invalid(`must not be longer than ${USER_AGENT_MAX_LENGTH} characters`);
  return v;
}

/** 送る値。base はブラウザの User-Agent（無ければ省く）、custom は検査済みの指定値 */
export function composeUserAgent(base: string | undefined, custom: string | undefined): string {
  return [base, custom, weiwudiProduct()].filter((s): s is string => typeof s === 'string' && s !== '').join(' ');
}

/** 取得の行き先と mode（fetch(input, init) と同じ解決。相対の URL は base で解く）。解けなければ undefined */
const targetOf = (input: Request | string, init: RequestInit | undefined, base: string | undefined): { url: URL; mode: RequestMode } | undefined => {
  try {
    if (typeof input === 'string') return { url: new URL(input, base), mode: init?.mode ?? 'cors' };
    return { url: new URL(input.url), mode: init?.mode ?? input.mode };
  } catch (_e) {
    return undefined;
  }
};

/** User-Agent を付けるか: SW と同じオリジンで、mode が cors か same-origin のときだけ */
export function shouldAttachUserAgent(input: Request | string, init: RequestInit | undefined, self: { origin: string; href: string } | undefined): boolean {
  if (!self) return false;
  const t = targetOf(input, init, self.href);
  if (!t) return false;
  return t.url.origin === self.origin && (t.mode === 'cors' || t.mode === 'same-origin');
}

/**
 * User-Agent を付けた要求を作る。要求がすでに User-Agent を持っていれば undefined（元のまま送る）。
 * 作れなければ undefined（元のまま送り、fetch 自身にエラーを出させる）
 */
export function withUserAgent(input: Request | string, init: RequestInit | undefined, value: string): Request | undefined {
  let request: Request;
  try {
    request = new Request(input, init);
    if (request.headers.has('user-agent')) return undefined;
    const headers = new Headers(request.headers);
    headers.set('user-agent', value);
    return new Request(request, { headers });
  } catch (_e) {
    return undefined;
  }
}
