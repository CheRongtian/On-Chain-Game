import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '');
  const proxy = {
    '/api': {
      target: `http://${process.env.HTTP_ADDRESS || env.HTTP_ADDRESS || '127.0.0.1:8080'}`,
      rewrite: (path) => path.replace(/^\/api/, ''),
      configure(proxy) {
        proxy.on('proxyRes', (upstream, _request, downstream) => {
          if (!upstream.headers['content-type']?.startsWith('text/event-stream')) return;
          // A killed Go process must also disconnect the browser's event stream.
          const disconnect = () => downstream.destroy();
          upstream.on('aborted', disconnect);
          upstream.on('error', disconnect);
        });
      },
    },
  };
  return {
    plugins: [vue()],
    server: {
      proxy,
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
      proxy,
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      headers: {
        'Content-Security-Policy': [...resourcePolicy, localConnections].join('; '),
      },
    },
  };
});
