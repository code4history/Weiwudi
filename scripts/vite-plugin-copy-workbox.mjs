// デモの Service Worker が読む workbox の一式を public/workbox/ に写す。
// 第三者の CDN から Service Worker へ script を読み込まないため、デモと一緒に配る。
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copyWorkboxLibraries } from 'workbox-build';

/** workbox の一式を `<publicDir>/workbox/` に置く（前の一式は置き換える）。 */
export async function copyWorkbox(publicDir) {
  const versionedName = await copyWorkboxLibraries(publicDir);
  const destination = join(publicDir, 'workbox');
  rmSync(destination, { recursive: true, force: true });
  renameSync(join(publicDir, versionedName), destination);
}

/** ビルドと開発サーバーの開始時に `copyWorkbox` を 1 回呼ぶ vite プラグイン。 */
export function copyWorkboxPlugin() {
  let publicDir;
  let copied;
  const copyOnce = () => (copied ??= copyWorkbox(publicDir));
  return {
    name: 'copy-workbox',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    buildStart: copyOnce,
    configureServer: copyOnce,
  };
}
