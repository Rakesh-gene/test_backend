import { execa } from 'execa';
import { delimiter } from 'node:path';
import { existsSync } from 'node:fs';

export function findExecutable(name: string): string | undefined {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of extensions) {
      const path = `${directory.replace(/^"|"$/g, '')}/${name}${ext}`;
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}
export async function command(
  executable: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
) {
  return execa(executable, args, {
    ...options,
    timeout: options.timeout ?? 15000,
    reject: false,
    windowsHide: true,
    stdin: 'ignore',
    maxBuffer: 1024 * 1024,
  });
}
