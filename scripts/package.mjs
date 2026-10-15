import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extensionDir = resolve(root, 'extension');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
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
await normalizeZipEntryNames(output);
console.log(output);

function slashify(data, start, length) {
  let patched = 0;
  for (let index = start; index < start + length; index++) {
    if (data[index] === 0x5c) {
      data[index] = 0x2f;
      patched += 1;
    }
  }
  return patched;
}

/** Walks the central directory and returns every entry with its two name offsets. */
function readZipEntries(data) {
  const eocd = data.lastIndexOf(EOCD_SIGNATURE);
  if (eocd < 0) throw new Error('打包失败：ZIP 缺少中央目录。');
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(offset) !== CENTRAL_HEADER) throw new Error('打包失败：ZIP 中央目录结构异常。');
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    if (data.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error('打包失败：ZIP 本地头结构异常。');
    const localNameLength = data.readUInt16LE(localOffset + 26);
    entries.push({
      central: offset + 46,
      local: localOffset + 30,
      nameLength,
      localNameLength,
      name: data.toString('utf8', offset + 46, offset + 46 + nameLength),
      localName: data.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Windows' Compress-Archive writes entry names with backslashes, which the ZIP
 * spec forbids: macOS and Linux extractors then produce one oddly named file
 * instead of the `extension/` directory. Rewriting the separators in place is a
 * 1-byte-for-1-byte edit, so every offset and CRC stays valid. No-op on archives
 * that already use forward slashes (the non-Windows path).
 */
async function normalizeZipEntryNames(file) {
  const data = await readFile(file);
  let patched = 0;
  for (const entry of readZipEntries(data)) {
    patched += slashify(data, entry.central, entry.nameLength);
    patched += slashify(data, entry.local, entry.localNameLength);
  }
  if (patched) await writeFile(file, data);
  // Verify the archive as written: a silent write failure, a partial patch or a
  // missing payload must not ship.
  const shipped = readZipEntries(await readFile(file));
  if (!shipped.some(entry => entry.name === 'extension/manifest.json')) throw new Error('打包失败：ZIP 中没有 extension/manifest.json。');
  const broken = shipped.filter(entry => entry.name.includes('\\') || entry.localName.includes('\\'));
  if (broken.length) throw new Error(`打包失败：ZIP 仍有 ${broken.length} 个条目使用反斜杠分隔符。`);
  console.log(`zip entries: ${shipped.length}, separator(s) normalized to '/': ${patched}`);
}
