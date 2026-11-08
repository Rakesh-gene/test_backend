import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execa } from 'execa';
import { findExecutable } from '@kode/execution';

// Synthetic files only. This tests the kernel boundary without relying on a
// language model choosing to invoke a tool or refusing a private-file request.
const root = await mkdtemp(resolve('.artifacts/native-boundary-'));
const scope = join(root, 'scope'),
  control = join(scope, 'control');
await mkdir(control, { recursive: true });
await writeFile(join(control, 'canary.txt'), 'synthetic-private-canary');
await writeFile(join(root, 'outside.txt'), 'preserve');
const filesystem = {
  ':root': 'read',
  [scope.replaceAll('\\', '/')]: 'write',
  [control.replaceAll('\\', '/')]: 'deny',
};
const profile = `{ ${Object.entries(filesystem)
  .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
  .join(', ')} }`;
const code = `
const fs=require('fs');let deniedRead=false,deniedWrite=false;
try{fs.readFileSync(${JSON.stringify(join(control, 'canary.txt'))})}catch{deniedRead=true}
try{fs.writeFileSync(${JSON.stringify(join(root, 'outside.txt'))},'escaped')}catch{deniedWrite=true}
fs.writeFileSync(${JSON.stringify(join(scope, 'allowed.txt'))},'allowed');
console.log(JSON.stringify({deniedRead,deniedWrite,allowedWrite:true}));
if(!deniedRead||!deniedWrite)process.exitCode=77;`;
const executable = findExecutable('codex');
if (!executable)
  throw new Error('Install the selected Codex runtime before native boundary qualification.');
const result = await execa(
  executable,
  [
    'sandbox',
    '--include-managed-config',
    '-P',
    'kode-boundary-proof',
    '-c',
    `permissions.kode-boundary-proof.filesystem=${profile}`,
    '-c',
    'permissions.kode-boundary-proof.network.enabled=false',
    '-C',
    scope,
    process.execPath,
    '-e',
    code,
  ],
  { reject: false, windowsHide: true, timeout: 60000 },
);
assert.equal(result.exitCode, 0, result.stderr);
const proof = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
assert.equal(proof.deniedRead, true);
assert.equal(proof.deniedWrite, true);
assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'preserve');
assert.equal(await readFile(join(scope, 'allowed.txt'), 'utf8'), 'allowed');
await writeFile(
  '.artifacts/GAP-007-native-boundary.json',
  JSON.stringify(
    {
      passed: true,
      platform: process.platform,
      arch: process.arch,
      recordedAt: new Date().toISOString(),
      managedConfigIncluded: true,
      proof,
      limitation:
        'Direct native sandbox proof; model refusal alone is not kernel enforcement evidence.',
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(proof));
