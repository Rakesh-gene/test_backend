import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('.artifacts', { recursive: true });
const timeoutMs = Number(process.env.KODE_VERIFY_TIMEOUT_MS ?? 90000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
  throw new Error('KODE_VERIFY_TIMEOUT_MS must be an integer from 1000 to 600000.');
const checks = [
  ['typecheck', ['node_modules/typescript/bin/tsc', '-b', '--pretty', 'false']],
  ['lint', ['node_modules/eslint/bin/eslint.js', '.']],
  [
    'tests',
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--reporter=json',
      '--outputFile=.artifacts/vitest.json',
    ],
  ],
  ['terminal', ['scripts/terminal-test.mjs']],
  ['doctor', ['apps/cli/dist/index.js', 'doctor', '--json']],
];
const results = [];
for (const [name, args] of checks) {
  const start = Date.now();
  const result = await execa(process.execPath, args, {
    reject: false,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  results.push({
    name,
    command: ['node', ...args],
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    timeoutMs,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  console.log(`${name}: ${result.exitCode === 0 ? 'pass' : 'FAIL'} (${Date.now() - start} ms)`);
}
const output = {
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  recordedAt: new Date().toISOString(),
  cwd: resolve('.'),
  results,
};
await writeFile('.artifacts/verification.json', JSON.stringify(output, null, 2));
if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
