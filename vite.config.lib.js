import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    build: {
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
