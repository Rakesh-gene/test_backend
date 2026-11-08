import { execa } from 'execa';
import { delimiter, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
export { windowsOwnership, commandHost } from './ownership.js';
export const executionCapabilities = {
  commands: {
    ownership: process.platform === 'win32' ? 'windows-job-required' : 'process-group',
    filesystem: 'os-user',
    strictIsolation: false,
    summary:
      process.platform === 'win32'
        ? 'Windows Job Object; filesystem uses OS-user permissions'
        : 'Process group; detached descendants and filesystem remain uncontained',
  },
};

export function findExecutable(
  name: string,
  searchPath = process.env.PATH ?? '',
): string | undefined {
  if (isAbsolute(name)) return existsSync(name) ? name : undefined;
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of searchPath.split(delimiter)) {
    for (const ext of extensions) {
      const path = `${directory.replace(/^"|"$/g, '')}/${name}${ext}`;
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}
export function effectiveEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of [...Object.entries(process.env), ...Object.entries(overrides)])
    if (value !== undefined) result[process.platform === 'win32' ? key.toUpperCase() : key] = value;
  return result;
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
