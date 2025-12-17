import { defineConfig } from 'vite';
// import { VitePWA } from 'vite-plugin-pwa'; // PWA plugin might be redundant if we are just building the SW script itself, or we misconfigured it.

export default defineConfig({
    build: {
        outDir: 'dist',
        sourcemap: true,
        lib: {
            entry: 'src/weiwudi.js',
            name: 'Weiwudi',
            fileName: (format) => `weiwudi.${format}.js`, // Adjust output names to stay clean
            formats: ['umd', 'es'] // Support both for compatibility
        },
        rollupOptions: {
            // Ensure specific dependencies are externalized if necessary
            // external: ['workbox-core', ...], But usually we want to bundle them if it produces a standalone SW.
        }
    },
    // plugins: [ VitePWA(...) ] // checking if strictly needed
});
