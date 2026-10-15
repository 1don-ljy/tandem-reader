import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extensionDir = resolve(root, 'extension');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json 中的版本号无效：${version}`);

async function listFiles(dir, prefix = '') {
  const entries = await readdir(resolve(dir, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(dir, name));
    else files.push(name);
  }
  return files;
}

/** Packaging preflight: a half-built or development build must never ship. */
const failures = [];
let manifest;
try {
  manifest = JSON.parse(await readFile(resolve(extensionDir, 'manifest.json'), 'utf8'));
} catch {
  manifest = undefined;
}
if (!manifest) {
  failures.push('extension/manifest.json 不存在，请先运行 npm run build。');
} else if (manifest.version !== version) {
  failures.push(`extension/manifest.json 的版本 ${manifest.version} 与 package.json 的版本 ${version} 不一致，请重新运行 npm run build。`);
}

const files = manifest ? await listFiles(extensionDir) : [];
for (const required of ['background.js', 'content.js', 'options.js', 'popup.js', 'options.html', 'popup.html']) {
  if (!files.includes(required)) failures.push(`extension/${required} 不存在，请先运行 npm run build。`);
}
const maps = files.filter(file => file.endsWith('.map'));
if (maps.length) failures.push(`extension/ 中存在 sourcemap，说明这是开发构建：${maps.join('、')}。请运行 npm run build 后重试。`);
const tests = files.filter(file => /\.test\./.test(file));
if (tests.length) failures.push(`extension/ 中存在测试文件：${tests.join('、')}。`);

if (failures.length) {
  for (const failure of failures) console.error(`打包预检失败：${failure}`);
  process.exit(1);
}

await mkdir(resolve(root, 'dist'), { recursive: true });
const output = resolve(root, `dist/tandem-reader-${version}.zip`);
if (process.platform === 'win32') {
  const quotedOutput = `'${output.replaceAll("'", "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath 'extension','README.md','LICENSE' -DestinationPath ${quotedOutput} -Force`], { stdio: 'inherit', cwd: root });
} else {
  execFileSync('zip', ['-r', output, 'extension', 'README.md', 'LICENSE'], { stdio: 'inherit', cwd: root });
}
console.log(output);
