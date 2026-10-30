import { defineConfig } from 'vite';
import { copyWorkboxPlugin } from './scripts/vite-plugin-copy-workbox.mjs';

export default defineConfig({
    base: './', // Use relative paths for assets
    plugins: [copyWorkboxPlugin()],
    build: {
        outDir: 'dist-demo',
        emptyOutDir: true,
        // Build the demo site (index.html)
        rollupOptions: {
            input: {
                main: './index.html'
            }
        }
    },
    define: {
        'process.env.NODE_ENV': '"production"'
    },
    // Same server config as main vite.config.js for consistency
    server: {
        headers: {
            'Service-Worker-Allowed': '/'
        }
    }
});
