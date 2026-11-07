import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';

const manifests = ['package.json'];
for (const category of ['apps', 'packages'])
  for (const entry of await readdir(category, { withFileTypes: true }))
    if (entry.isDirectory()) manifests.push(join(category, entry.name, 'package.json'));
for (const path of manifests) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const group of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[group] ?? {})) {
      if (name.startsWith('@kode/')) continue;
      let directory = resolve(dirname(path));
      let version;
      while (!version) {
        try {
          const installed = JSON.parse(
            await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'),
          );
          version = installed.version;
        } catch {
          /* search the next ancestor */
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      if (!version) throw new Error(`Cannot pin installed dependency ${name} for ${path}`);
      manifest[group][name] = version;
    }
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`Pinned installed dependency versions in ${manifests.length} npm workspace manifests.`);
