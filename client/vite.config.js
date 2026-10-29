import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { replacePlugin } from 'rolldown/plugins';

const phaserSource = fileURLToPath(
  new URL('./src/phaser-esm.js', import.meta.resolve('phaser/package.json')),
);
// Phaser uses typeof expressions as compile-time switches in its source build.
const phaserConstants = {
  'typeof CANVAS_RENDERER': 'true',
  'typeof WEBGL_RENDERER': 'true',
  'typeof WEBGL_DEBUG': 'false',
  'typeof FEATURE_SOUND': 'true',
  'typeof PLUGIN_CAMERA3D': 'false',
  'typeof PLUGIN_FBINSTANT': 'false',
};

const resourcePolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
];
const localConnections = "connect-src 'self' http://127.0.0.1:18545";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '');
  const proxy = {
    '/api': {
      target: `http://${process.env.HTTP_ADDRESS || env.HTTP_ADDRESS || '127.0.0.1:18081'}`,
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
    // The published engine is a single module; its source can be split into cached chunks.
    resolve: { alias: [{ find: /^phaser$/, replacement: phaserSource }] },
    optimizeDeps: {
      rolldownOptions: { plugins: [replacePlugin(phaserConstants)] },
    },
    build: {
      rolldownOptions: {
        plugins: [replacePlugin(phaserConstants)],
        output: {
          strictExecutionOrder: true,
          codeSplitting: {
            groups: [
              {
                name: 'phaser',
                test: /node_modules[\\/]phaser[\\/]src[\\/]/,
                maxSize: 400_000,
              },
            ],
          },
        },
      },
    },
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
