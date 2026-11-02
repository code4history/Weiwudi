import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    publicDir: false,
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
            // weiwudi.d.ts が ./errors を参照するので、errors.d.ts も出す（#33）
            include: ['src/weiwudi.ts', 'src/errors.ts'],
            outDir: 'dist',
            insertTypesEntry: true
        })
    ]
});
