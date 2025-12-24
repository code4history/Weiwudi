import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: 5173,
    },
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            // Add Service-Worker-Allowed header for SW scripts
            if (req.url && req.url.includes('weiwudi-sw')) {
                res.setHeader('Service-Worker-Allowed', '/');
            }
            next();
        });
    }
});
