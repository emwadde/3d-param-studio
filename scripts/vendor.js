// Copies the browser builds this project vendors (loaded via plain <script> tags in
// studio.html, not bundled by Vite) from node_modules into public/vendor. Runs via the
// "postinstall" script, so `npm install` always leaves public/vendor matching whatever
// versions are pinned in package.json.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
  ['three/build/three.min.js', 'three.min.js'],
  ['mathjs/lib/browser/math.js', 'math.js'],
];

mkdirSync(join(root, 'public/vendor'), { recursive: true });
for (const [src, dest] of files) {
  copyFileSync(join(root, 'node_modules', src), join(root, 'public/vendor', dest));
  console.log(`vendored ${src} -> public/vendor/${dest}`);
}
