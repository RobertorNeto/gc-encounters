// Build da extensao: cada entry vira um bundle IIFE isolado em dist/.
// Sem framework, sem code splitting — content scripts MV3 nao aceitam ESM.
import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const ENTRIES = {
  'background/service-worker': 'src/background/service-worker.ts',
  'content/match': 'src/content/match.ts',
  'content/my-matches': 'src/content/my-matches.ts',
  'content/lobby': 'src/content/lobby.ts',
  'content/profile': 'src/content/profile.ts',
  'ui/options': 'src/ui/options.ts',
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: Object.fromEntries(
    Object.entries(ENTRIES).map(([o, i]) => [o, path.join(root, i)]),
  ),
  outdir: out,
  bundle: true,
  format: 'iife',
  target: ['chrome114', 'firefox115'],
  platform: 'browser',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  alias: { '@': path.join(root, 'src') },
  define: { __DEV__: String(dev) },
};

async function copyStatic() {
  await cp(path.join(root, 'src/manifest.json'), path.join(out, 'manifest.json'));
  // So os PNGs finais: a arte-fonte (source.jpg) nao vai para o pacote da loja.
  await mkdir(path.join(out, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await cp(path.join(root, `src/icons/icon${size}.png`), path.join(out, `icons/icon${size}.png`));
  }
  await cp(path.join(root, 'src/ui/options.html'), path.join(out, 'ui/options.html'));
  await cp(path.join(root, 'src/ui/options.css'), path.join(out, 'ui/options.css'));
}

// Esvazia dist/ em vez de remover a pasta: no Windows, um watcher (VS Code, servidor
// estatico, Explorer) segurando o diretorio raiz derruba o rm com EBUSY.
await mkdir(out, { recursive: true });
for (const entry of await readdir(out)) {
  await rm(path.join(out, entry), { recursive: true, force: true });
}
await mkdir(path.join(out, 'ui'), { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await copyStatic();
  console.log('watching…');
} else {
  await esbuild.build(options);
  await copyStatic();
  console.log('built -> dist/');
}
