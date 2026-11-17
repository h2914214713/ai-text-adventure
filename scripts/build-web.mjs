import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('public/assets', { recursive: true });

await build({
  entryPoints: ['web/main.js'],
  bundle: true,
  outfile: 'public/assets/app.js',
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  charset: 'utf8',
  minify: true,
  legalComments: 'none',
  alias: { vue: 'vue/dist/vue.esm-bundler.js' },
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
});
