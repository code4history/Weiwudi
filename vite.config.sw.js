import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: true,
        lib: {
            entry: './src/weiwudi_gw.ts',
            name: 'Weiwudi_SW',
            formats: ['umd', 'es'], // Library for building Service Workers (not the SW itself)
            fileName: (format) => `weiwudi-sw.${format}.js`
        },
        rollupOptions: {
            // external: ['workbox-routing', 'workbox-strategies'] // Removed external to bundle workbox-routing
        }
    },
    define: {
        REVISION: '"202501010000"',
        'process.env.NODE_ENV': '"production"'
    },
    plugins: [
        dts({
            include: ['src/weiwudi_gw.ts', 'src/weiwudi_gw_logic.ts'],
            outDir: 'dist',
            insertTypesEntry: true
        })
    ]
});
