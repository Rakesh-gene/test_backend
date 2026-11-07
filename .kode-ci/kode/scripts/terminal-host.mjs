import { spawn } from 'node:child_process';
// Keep the owned PTY console alive after the CLI exits, so node-pty can release
// its Windows console handles without racing AttachConsole against a dead PID.
const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  process.stdout.write(`KODE_APP_ERROR=${error.message}\n`);
});
child.on('exit', (code) => {
  process.stdout.write(`\nKODE_APP_EXIT=${code}\n`);
  process.stdin.resume();
});
const keepAlive = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  if (child.exitCode === null) child.kill();
  process.exitCode = 0;
});
