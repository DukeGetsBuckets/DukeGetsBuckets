// Builds bookmarklet.txt and install.html from scanner.js.
//   npm install   (once)
//   npm run build
import { minify } from 'terser';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'scanner.js'), 'utf8');

const result = await minify(src, {
  compress: { passes: 2, drop_console: false },
  mangle: true,
  format: { comments: false, ascii_only: true }
});
if (!result.code) throw new Error('terser produced no output');
const code = result.code.trim();

// A bookmarklet is a javascript: URL. Percent-encoding keeps every character safe
// inside a Safari bookmark; the browser decodes it before running the code.
const bookmarklet = 'javascript:' + encodeURIComponent(code);
writeFileSync(join(here, 'bookmarklet.txt'), bookmarklet + '\n');

// The installer page embeds the minified code and can bake in the user's settings.
const template = readFileSync(join(here, 'install.template.html'), 'utf8');
const embedded = JSON.stringify(code).replace(/<\/script/gi, '<\\/script');
const version = /VERSION = '([^']+)'/.exec(src)?.[1] ?? 'dev';
const html = template.replace('__QSCAN_CODE__', embedded).replace(/__QSCAN_VERSION__/g, version);
writeFileSync(join(here, 'install.html'), html);

console.log(`scanner.js ${src.length} bytes -> minified ${code.length} bytes -> bookmarklet ${bookmarklet.length} bytes`);
console.log('wrote bookmarklet.txt and install.html');
