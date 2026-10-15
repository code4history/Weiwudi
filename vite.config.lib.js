import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    publicDir: false,
    build: {
        // nov26-m9-t6 S3: base（vite 7）の解決値を明示して保つ（t6 §3.3）
        target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
        cssTarget: ['chrome107', 'edge107', 'firefox104', 'safari16'],
        minify: 'esbuild',
        outDir: 'dist',
        sourcemap: true,
        lib: {
            entry: './src/weiwudi.ts',
            name: 'Weiwudi',
            formats: ['umd', 'es'],
            fileName: (format) => `weiwudi.${format}.js`
        }
    },
    plugins: [
        dts({
            include: ['src/weiwudi.ts'],
            outDir: 'dist',
            insertTypesEntry: true
        })
    ]
});
