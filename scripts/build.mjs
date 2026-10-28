import {cpSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'public');

// BotID's client needs challenge routes that only exist on Vercel, so local builds leave it out.
export async function bundle({botId}) {
  rmSync(outDir, {recursive: true, force: true});
  mkdirSync(outDir);
  await build({
    absWorkingDir: root,
    entryPoints: {app: 'web/app.mjs', worker: 'web/worker.mjs', style: 'web/style.css'},
    outdir: outDir,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    define: {BOTID: String(botId)},
  });
  for (const name of ['index.html', 'favicon.svg']) cpSync(path.join(root, 'web', name), path.join(outDir, name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundle({botId: true});
