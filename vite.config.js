import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        headers: {
            'Service-Worker-Allowed': '/'
        }
    }
});
