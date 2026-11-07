import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const files = [];
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name.endsWith('.tsbuildinfo')
    )
      continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) await visit(target);
    else files.push(target);
  }
}
for (const root of ['apps', 'packages', 'scripts', 'tests', 'schemas', '.github', 'docs'])
  await visit(root);
files.push(
  'package.json',
  'README.md',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  '.nvmrc',
  '.npmrc',
  'eslint.config.mjs',
  'vitest.config.ts',
);
const entries = [];
for (const path of files.sort())
  entries.push({
    path: path.replaceAll('\\', '/'),
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  });
const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
await mkdir('.artifacts', { recursive: true });
await writeFile(
  '.artifacts/source-manifest.json',
  JSON.stringify({ schemaVersion: 1, digest, entries }, null, 2),
);
console.log(JSON.stringify({ digest, files: entries.length }));
