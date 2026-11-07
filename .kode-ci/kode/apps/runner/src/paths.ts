import { createHash } from 'node:crypto';
import { realpath, mkdir, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function protectStateDirectory(state: string) {
  if (process.platform !== 'win32') {
    await chmod(state, 0o700);
    return;
  }
  const identity = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: 5000,
  });
  const sid = identity.stdout.match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error('Cannot determine Windows identity for private workspace state.');
  await execute(
    'icacls.exe',
    [state, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { windowsHide: true, timeout: 5000 },
  );
}

export async function workspacePaths(root: string) {
  const canonical = await realpath(root);
  const key = createHash('sha256')
    .update(
      `${process.platform === 'win32' ? canonical.toLowerCase() : canonical}:${userInfo().username}`,
    )
    .digest('hex')
    .slice(0, 24);
  const state = join(canonical, '.kode');
  await mkdir(state, { recursive: true, mode: 0o700 });
  if ((await lstat(state)).isSymbolicLink())
    throw new Error('Kode state directory must not be a symlink or junction.');
  if (process.platform !== 'win32') await chmod(state, 0o700);
  for (const name of ['state.sqlite', 'control.token', 'runner.lock', 'runner.log']) {
    const entry = await lstat(join(state, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (entry?.isSymbolicLink()) throw new Error(`Kode state file ${name} must not be a symlink.`);
  }
  const ipcDir = join(tmpdir(), `kode-${key}`);
  await mkdir(ipcDir, { recursive: true, mode: 0o700 });
  return {
    root: canonical,
    state,
    database: join(state, 'state.sqlite'),
    token: join(state, 'control.token'),
    lease: join(state, 'runner.lock'),
    log: join(state, 'runner.log'),
    endpoint:
      process.platform === 'win32' ? `\\\\.\\pipe\\kode-${key}` : join(ipcDir, 'runner.sock'),
  };
}
export type Paths = Awaited<ReturnType<typeof workspacePaths>>;
