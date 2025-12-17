import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false, // Don't wipe the lib build
        sourcemap: true,
        lib: {
            entry: 'src/weiwudi_gw.js',
            name: 'WeiwudiSW',
            fileName: 'weiwudi-sw',
            formats: ['iife'] // Service Workers are typically single scripts (iife)
        },
        rollupOptions: {
            output: {
                entryFileNames: 'weiwudi-sw.js',
                // Ensure workbox is bundled
            }
        }
    },
    define: {
        'process.env.NODE_ENV': '"production"' // Workbox expects this
    }
});
