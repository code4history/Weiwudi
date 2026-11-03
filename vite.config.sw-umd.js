import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// /v2/ping が返す版（package.json と同じ。m2-t8・第 1 回 S13）
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
    publicDir: false,
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: true,
        lib: {
            entry: './src/weiwudi_sw.ts',
            name: 'Weiwudi_SW',
            formats: ['umd'], // UMD only for importScripts/CDN usage
            fileName: () => `weiwudi-sw.umd.js`
        },
        rollupOptions: {
            // No external - expects self.workbox at runtime
        }
    },
    define: {
        REVISION: '"202501010000"',
        __WEIWUDI_VERSION__: JSON.stringify(version),
        'process.env.NODE_ENV': '"production"'
    }
});
