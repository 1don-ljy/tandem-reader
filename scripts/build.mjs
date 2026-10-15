import { build, context } from 'esbuild';
import { watch as watchFiles } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'extension');
const publicDir = resolve(root, 'public');
const watch = process.argv.includes('--watch');
const production = !watch && !process.argv.includes('--dev');
/** Placeholder replaced with the package.json version, the single source of truth. */
const VERSION_PLACEHOLDER = '__VERSION__';

const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json 中的版本号无效：${version}`);

/** Copies public/ into extension/ and injects the package.json version into the manifest. */
async function syncPublic() {
  await mkdir(outdir, { recursive: true });
  for (const file of await readdir(publicDir)) {
    if (file === 'manifest.json') continue;
    await cp(resolve(publicDir, file), resolve(outdir, file), { force: true });
  }
  // Substituting the placeholder keeps the template's own formatting, so the built
  // manifest stays byte-identical whenever the version is unchanged.
  const template = await readFile(resolve(publicDir, 'manifest.json'), 'utf8');
  const placeholders = template.split(VERSION_PLACEHOLDER).length - 1;
  if (placeholders !== 1) {
    throw new Error(`public/manifest.json 应恰好包含一处 ${VERSION_PLACEHOLDER} 占位符，实际 ${placeholders} 处；版本号以 package.json 为唯一来源。`);
  }
  const manifest = template.replace(VERSION_PLACEHOLDER, version);
  JSON.parse(manifest);
  await writeFile(resolve(outdir, 'manifest.json'), manifest);
}

/** Removes development sourcemaps so a packaged build can never ship them. */
async function removeSourcemaps() {
  for (const file of await readdir(outdir)) {
    if (file.endsWith('.map')) await rm(resolve(outdir, file));
  }
}

const shared = {
  bundle: true,
  target: 'chrome120',
  platform: 'browser',
  legalComments: 'linked',
  logLevel: 'info',
  metafile: true,
  loader: { '.css': 'text' },
  // Only development builds carry sourcemaps; the packaging preflight rejects stale maps.
  sourcemap: production ? false : 'linked',
};

const bundles = [
  { name: 'background', options: { ...shared, entryPoints: { background: 'src/background/index.ts' }, outdir, format: 'esm' } },
  { name: 'content', options: { ...shared, entryPoints: { content: 'src/content/index.ts' }, outdir, format: 'iife' } },
  { name: 'popup+options', options: { ...shared, entryPoints: { popup: 'src/ui/popup.ts', options: 'src/ui/options.ts' }, outdir, format: 'esm' } },
];

function assertBundledAgent(name, result) {
  if (name !== 'background') return;
  const dependencies = Object.keys(result.metafile.inputs);
  if (!dependencies.some(path => path.includes('pi-agent-core'))) throw new Error('Pi Agent 未包含在后台构建中。');
  console.log('Pi Agent runtime bundled for Manifest V3.');
}

// Compatibility build for the pre-2.6 test location; tests now import src/** directly.
async function buildTestBundle() {
  await build({
    entryPoints: ['src/shared/core.ts', 'src/shared/providers.ts', 'src/shared/translation-output.ts', 'src/shared/domain-analysis.ts', 'src/memory/repository.ts', 'src/agent/translation-agent.ts', 'src/background/migrations.ts'],
    outbase: 'src',
    outdir: '.test-build',
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'info',
  });
}

await syncPublic();
if (production) await removeSourcemaps();

if (watch) {
  const contexts = [];
  for (const bundle of bundles) {
    const buildContext = await context({
      ...bundle.options,
      plugins: [{ name: 'sync-public', setup(build) { build.onEnd(() => syncPublic()); } }],
    });
    assertBundledAgent(bundle.name, await buildContext.rebuild());
    await buildContext.watch();
    contexts.push(buildContext);
  }
  watchFiles(publicDir, () => { syncPublic().catch(error => console.error(error)); });
  await buildTestBundle();
  console.log(`watching for changes (development build, version ${version}); reload the extension in the browser to apply.`);
} else {
  for (const bundle of bundles) assertBundledAgent(bundle.name, await build(bundle.options));
  await buildTestBundle();
  console.log(`built extension/ with ${production ? 'no sourcemaps' : 'development sourcemaps'}, version ${version}.`);
}
