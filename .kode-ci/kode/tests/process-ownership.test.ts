import { test, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { RepoManifest, runDeclared } from '@kode/workspace';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFile(path: string) {
  for (let n = 0; n < 150; n++) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text) return text;
    await pause(20);
  }
  throw new Error('Owned fixture did not become ready.');
}

test.runIf(process.platform === 'win32')(
  'kernel ownership stops detached double-fork descendants after direct exit and hard owner crash without stopping unrelated processes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kode-job-'));
    const unrelated = execa(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], {
      reject: false,
      windowsHide: true,
    });
    const results: unknown[] = [];
    try {
      for (const crash of [false, true]) {
        const ready = join(root, `ready-${crash}`),
          escaped = join(root, `escaped-${crash}`);
        // The target forks an intermediate which forks a detached child and exits.
        const descendant = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(escaped)},'escaped'),2000)`;
        const intermediate = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}).unref()`;
        const target = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{detached:true,stdio:'ignore'}).unref();const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){${crash ? '' : 'clearInterval(t);process.exit(0)'}}},10);setTimeout(()=>process.exit(0),10000)`;
        const manifest = RepoManifest.parse({
          version: 1,
          commands: { probe: { run: ['node', '-e', target] } },
        });
        if (crash) {
          const script =
            "import {RepoManifest,runDeclared} from '@kode/workspace';await runDeclared(process.argv[1],RepoManifest.parse(JSON.parse(process.argv[2])),'probe');";
          const owner = execa(
            process.execPath,
            ['--input-type=module', '-e', script, root, JSON.stringify(manifest)],
            { reject: false, windowsHide: true },
          );
          try {
            await waitFile(ready);
            owner.kill('SIGKILL');
            await owner;
          } finally {
            owner.kill('SIGKILL');
            await owner;
          }
        } else {
          expect((await runDeclared(root, manifest, 'probe')).status).toBe('passed');
        }
        await pause(2300);
        expect(
          await access(escaped).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        expect(unrelated.nodeChildProcess.exitCode).toBeNull();
        results.push({
          crash,
          detachedDoubleForkReady: true,
          escapedWrite: false,
          unrelatedAlive: true,
        });
      }
      await mkdir('.artifacts', { recursive: true });
      await writeFile(
        '.artifacts/GAP-007-ownership.json',
        JSON.stringify(
          {
            passed: true,
            platform: process.platform,
            arch: process.arch,
            boundary: 'non-inherited Windows Job Object / kill-on-close / pre-dispatch gate',
            results,
          },
          null,
          2,
        ),
      );
    } finally {
      unrelated.kill('SIGKILL');
      await unrelated;
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  20000,
);
