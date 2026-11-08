import { execa } from 'execa';

// Trusted bootstrap. The target cannot execute until the parent assigns this host
// to its kernel ownership boundary and writes the handshake. No shell interpolation.
let prefix = Buffer.alloc(0);
let dispatched = false;
const gate = (chunk: Buffer) => {
  prefix = Buffer.concat([prefix, chunk]);
  const end = prefix.indexOf(10);
  if (end < 0) {
    if (prefix.length > 1024 * 1024) process.exit(126);
    return;
  }
  process.stdin.off('data', gate);
  const line = prefix.subarray(0, end).toString();
  if (line !== 'KODE_GO' && !line.startsWith('KODE_GO ')) process.exit(126);
  const env =
    line === 'KODE_GO' ? process.env : (JSON.parse(line.slice(8)) as Record<string, string>);
  const [executable, ...args] = process.argv.slice(2);
  if (!executable) process.exit(126);
  dispatched = true;
  const child = execa(executable, args, {
    env,
    extendEnv: false,
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    reject: false,
  });
  child.stdin!.on('error', () => {});
  const remaining = prefix.subarray(end + 1);
  if (remaining.length) child.stdin!.write(remaining);
  process.stdin.pipe(child.stdin!);
  if (process.stdin.readableEnded) child.stdin!.end();
  void child.catch(() => process.exit(127));
  child.nodeChildProcess.on('error', () => process.exit(127));
  child.nodeChildProcess.on('exit', (code) => process.exit(code ?? 1));
};
process.stdin.on('data', gate);
process.stdin.on('end', () => {
  if (!dispatched) process.exit(126);
});
