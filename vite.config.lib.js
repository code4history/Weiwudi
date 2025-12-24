import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    build: {
        outDir: 'dist',
        sourcemap: true,
        lib: {
            entry: 'src/weiwudi.js',
            name: 'Weiwudi',
            fileName: (format) => `weiwudi.${format}.js`,
            formats: ['umd', 'es']
        },
        rollupOptions: {
            // Dependencies are bundled for standalone usage
        }
    },
    plugins: [
        dts({
            include: ['src/weiwudi.js'],
            outDir: 'dist',
            insertTypesEntry: true
        })
    ]
});
