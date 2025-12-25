import { defineConfig } from 'vite';

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
        'process.env.NODE_ENV': '"production"'
    }
});
