import { startRunner } from './index.js';
const rootIndex = process.argv.indexOf('--root');
const root = process.argv[rootIndex + 1] ?? process.cwd();
try {
  const runner = await startRunner(root, { testing: process.argv.includes('--fixture') });
  let stopping = false;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      void runner.close();
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
