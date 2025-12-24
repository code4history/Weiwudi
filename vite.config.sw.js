import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false, // Don't wipe the lib build
        sourcemap: true,
        lib: {
            entry: 'src/weiwudi_gw.js',
            name: 'WeiwudiSW',
            fileName: (format) => `weiwudi-sw.${format}.js`,
            formats: ['umd', 'es'] // Library for building Service Workers (not the SW itself)
        },
        rollupOptions: {
            // Ensure workbox dependencies are bundled
        }
    },
    plugins: [
        dts({
            include: ['src/weiwudi_gw.js', 'src/weiwudi_gw_logic.js'],
            outDir: 'dist',
            insertTypesEntry: true
        })
    ],
    define: {
        'process.env.NODE_ENV': '"production"' // Workbox expects this
    }
});
