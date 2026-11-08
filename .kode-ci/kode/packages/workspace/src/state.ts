import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
export function scoped(root: string, path: string) {
  if (isAbsolute(path) || path.includes('\0')) throw new Error('Expected a relative path.');
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error(`Path escapes root: ${path}`);
  return target;
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path);
      break;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        attempt >= 5 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}
export async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
export async function leased<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  // Dead owners can be recovered; uncertain/live ownership never authorizes another writer.
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await json<{ pid: number }>(path).catch(() => undefined);
      if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            // A separate recovery lock serializes stale-owner reclamation.
            const recovery = await open(`${path}.recovery`, 'wx').catch(() => undefined);
            if (recovery) {
              try {
                if ((await readFile(path, 'utf8')) === JSON.stringify(owner)) await unlink(path);
              } finally {
                await recovery.close();
                await unlink(`${path}.recovery`);
              }
            }
          }
        }
      }
      if (attempt >= 600)
        throw new Error(`Resource is busy or its lease needs recovery: ${path}`, { cause: error });
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await action();
  } finally {
    await unlink(path);
  }
}
