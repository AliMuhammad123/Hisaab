// Builds the app into www/ (what Capacitor packs into the Android app):
// copies public/, bundles src/ into one script and writes the Supabase
// address into the page's Content Security Policy.
import { build } from 'esbuild';
import { cp, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// FAKE_SUPABASE=1 builds a test copy into www-test/ that uses tests/fake-supabase.js instead of a real project.
const fake = process.env.FAKE_SUPABASE === '1';
const out = join(root, fake ? 'www-test' : 'www');

const config = JSON.parse(await readFile(join(root, 'app.config.json'), 'utf8'));
const url = fake ? 'https://fake-test.supabase.co' : (process.env.SUPABASE_URL || config.supabaseUrl || '').trim().replace(/\/+$/, '');
const key = fake ? 'fake-test-key-0000000000000' : (process.env.SUPABASE_ANON_KEY || config.supabaseAnonKey || '').trim();
const ready = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && key.length > 20;
if (!ready) {
  console.warn('WARNING: app.config.json has no Supabase address and key yet. The app will build but cannot sign in.');
}
if (/service_role|sb_secret_/.test(key) || (key.split('.').length === 3 && /"role"\s*:\s*"service_role"/.test(Buffer.from(key.split('.')[1], 'base64url').toString()))) {
  console.error('STOP: that is the secret service_role key. Use the public "anon" (or "publishable") key. The secret key must never go into an app.');
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await cp(join(root, 'public'), out, { recursive: true });

await build({
  entryPoints: [join(root, 'src/main.js')],
  outfile: join(out, 'assets/app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  alias: fake ? { '@supabase/supabase-js': join(root, 'tests/fake-supabase.js') } : {},
  define: {
    __SUPABASE_URL__: JSON.stringify(ready ? url : ''),
    __SUPABASE_ANON_KEY__: JSON.stringify(ready ? key : ''),
  },
});

const page = join(out, 'index.html');
let html = await readFile(page, 'utf8');
const connect = ready ? `'self' ${url}` : "'self'";
html = html
  .replace(/connect-src [^;]+;/, `connect-src ${connect};`)
  .replace('<script type="module" src="assets/js/main.js"></script>', '<script type="module" src="assets/app.js"></script>');
await writeFile(page, html);
console.log(`Built ${fake ? 'www-test/ (fake Supabase, for testing only)' : 'www/'} ${fake ? '' : ready ? `for ${url}` : '(not connected to Supabase)'}`);
