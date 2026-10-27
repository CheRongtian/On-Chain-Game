import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const resourcePolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
];
const localConnections = "connect-src 'self' http://127.0.0.1:8545";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: {
      'Content-Security-Policy': [
        ...resourcePolicy,
        `${localConnections} ws://127.0.0.1:5173`,
      ].join('; '),
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: {
      'Content-Security-Policy': [...resourcePolicy, localConnections].join('; '),
    },
  },
});
