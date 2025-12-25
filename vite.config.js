import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
    appType: 'mpa', // Multi-Page App mode
    server: {
        port: 5173,
    },
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            // Force serve test HTML files to verify test isolation
            if (req.url && req.url.startsWith('/tests/') && req.url.split('?')[0].endsWith('.html')) {
                const urlPath = req.url.startsWith('/') ? req.url.slice(1).split('?')[0] : req.url.split('?')[0];
                const filePath = path.join(process.cwd(), urlPath);
                console.log('Test HTML Request:', req.url);
                console.log('Resolved File Path:', filePath);
                console.log('File Exists:', fs.existsSync(filePath));

                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    res.setHeader('Content-Type', 'text/html');
                    res.end(content);
                    return;
                }
            }

            // Add Service-Worker-Allowed header for SW scripts
            if (req.url && req.url.includes('weiwudi-sw')) {
                res.setHeader('Service-Worker-Allowed', '/');
            }
            next();
        });
    }
});
