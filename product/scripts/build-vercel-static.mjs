// Assembles the static site Vercel's CDN serves (pages, compiled browser modules, vendor files).
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'vercel-out');
rmSync(out, { recursive: true, force: true });
const copy = (from, to, filter = () => true) => {
  const src = join(root, from), dst = join(out, to);
  if (!existsSync(src)) throw new Error(`Missing build input: ${from} (run npm run build first)`);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) if (filter(f)) cpSync(join(src, f), join(dst, f), { recursive: true });
};
copy('product/public', '.');
copy('product/dist/product/browser', 'js/product/browser', f => f.endsWith('.js'));
copy('product/dist/src/media', 'js/src/media', f => f.endsWith('.js'));
copy('product/dist/src/shared', 'js/src/shared', f => f.endsWith('.js'));
copy('node_modules/three/build', 'vendor', f => f === 'three.module.js' || f === 'three.core.js');
copy('node_modules/@mediapipe/tasks-vision', 'vendor/mediapipe', f => f === 'vision_bundle.mjs');
copy('node_modules/@mediapipe/tasks-vision/wasm', 'vendor/mediapipe/wasm', f => /^vision_wasm(_nosimd|_module)?_internal\.(js|wasm)$/.test(f));
console.log(`Static site assembled in ${out}`);
