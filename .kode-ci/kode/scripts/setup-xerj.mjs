import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

// Digests from the official GitHub release API, pinned rather than fetched at install time.
const version = '1.0.0-rc.101';
const assets = {
  'win32-x64': [
    'x86_64-pc-windows-msvc.zip',
    '0d9c9be42e7607034789c63890f5910e6f7a1df2bcec5cae9753446815b49772',
  ],
  'win32-arm64': [
    'aarch64-pc-windows-msvc.zip',
    '9ada2bf498893653238c888591e3e6925331fa27f3f40bc01da42184542986ac',
  ],
  'darwin-x64': [
    'x86_64-apple-darwin.tar.gz',
    '49327e1931515d1c5ac66b9b06769f13dd1271c55ad279c6a7501b9e89a6ed76',
  ],
  'darwin-arm64': [
    'aarch64-apple-darwin.tar.gz',
    'eb2113ec8a7d3057d5ed97d91a52900b804108db173ba213292506926e6b790f',
  ],
  'linux-x64': [
    'x86_64-unknown-linux-gnu.tar.gz',
    '999647a588cb113b49ec27cb72c43afa6bf367d8fb2b079b510eee703b025800',
  ],
  'linux-arm64': [
    'aarch64-unknown-linux-gnu.tar.gz',
    '69ffd58123ea8e54b3be8bee2143a18a8455f4f943f9da114b86f3d0fbca16bb',
  ],
};
const target = `${process.platform}-${process.arch}`;
const asset = assets[target];
if (!asset) throw new Error(`No pinned XERJ asset for ${target}.`);
const [suffix, expected] = asset;
const name = `xerj-${version}-${suffix}`;
const url = `https://github.com/xerj-org/xerj/releases/download/v${version}/${name}`;
const root = resolve('.tools/xerj');
await mkdir(root, { recursive: true });
const archive = process.env.KODE_XERJ_ARCHIVE ?? join(root, name);
let bytes;
try {
  bytes = await readFile(archive);
} catch (error) {
  if (error.code !== 'ENOENT' || process.env.KODE_XERJ_ARCHIVE) throw error;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok)
    throw new Error(`XERJ download failed: HTTP ${response.status}.`, { cause: error });
  bytes = Buffer.from(await response.arrayBuffer());
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
if (sha256(bytes) !== expected)
  throw new Error('XERJ archive checksum mismatch; refusing extraction.');
// Always extract the verified bytes, including when the caller supplies a local archive.
const stage = await mkdtemp(join(root, 'verified-'));
const verifiedArchive = join(stage, name);
await writeFile(verifiedArchive, bytes);
const destination = join(stage, 'bin');
await mkdir(destination);
await execa('tar', ['-xf', verifiedArchive, '-C', destination], {
  timeout: 30000,
  windowsHide: true,
});
const binaryName = process.platform === 'win32' ? 'xerj.exe' : 'xerj';
const binaries = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && entry.name === binaryName) binaries.push(path);
  }
}
await visit(destination);
if (binaries.length !== 1)
  throw new Error('Expected exactly one XERJ executable in release archive.');
const binary = binaries[0];
if (process.platform !== 'win32') await chmod(binary, 0o755);
const result = {
  version,
  target,
  url,
  archiveSha256: expected,
  binary,
  binarySha256: sha256(await readFile(binary)),
};
await writeFile(join(root, 'installed.json'), JSON.stringify(result, null, 2));
await mkdir('.artifacts', { recursive: true });
await writeFile('.artifacts/xerj-install.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
