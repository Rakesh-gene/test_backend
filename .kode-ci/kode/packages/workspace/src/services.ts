import { createServer } from 'node:net';
import {
  type Manifest,
  type Observer,
  quiet,
  runDeclared,
  startProcess,
  substitute,
} from './project.js';

async function reserve(port: number | 'auto') {
  const server = createServer();
  server.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port === 'auto' ? 0 : port, '127.0.0.1', () => resolve());
  }).catch((error) => {
    throw new Error(`Service port collision (${port}); existing listener was preserved.`, {
      cause: error,
    });
  });
  const assigned = (server.address() as { port: number }).port;
  return {
    port: assigned,
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export async function runWithServices(
  root: string,
  manifest: Manifest,
  command: string,
  options: { signal?: AbortSignal; observe?: Observer } = {},
) {
  const spec = manifest.commands[command];
  if (!spec) throw new Error(`Unknown command: ${command}`);
  const observe = options.observe ?? quiet;
  const order: string[] = [],
    seen = new Set<string>();
  function visit(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dependency of manifest.services[id]!.depends_on) visit(dependency);
    order.push(id);
  }
  for (const id of spec.services) visit(id);
  const reservations = new Map<string, Awaited<ReturnType<typeof reserve>>>();
  const running: { name: string; process: Awaited<ReturnType<typeof startProcess>> }[] = [];
  const setup: string[] = [];
  const ports: Record<string, number> = {};
  const onAbort = () => {
    for (const item of running) void item.process.stop().catch(() => {});
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let result: Awaited<ReturnType<typeof runDeclared>> | undefined;
  let failure: unknown;
  let teardownFailed = false;
  try {
    for (const id of order) {
      const reservation = await reserve(manifest.services[id]!.port);
      reservations.set(id, reservation);
      ports[id] = reservation.port;
    }
    for (const id of order) {
      if (options.signal?.aborted) throw new Error('Service execution cancelled.');
      const service = manifest.services[id]!;
      if (service.setup) {
        setup.push(id); // Cleanup is attempted even when fixture setup fails.
        const result = await runDeclared(root, manifest, service.setup, { ...options, ports });
        if (result.status !== 'passed') throw new Error(`Fixture setup failed for service ${id}.`);
      }
      await reservations.get(id)!.release();
      reservations.delete(id);
      const process = await startProcess(root, manifest.commands[service.command]!, ports, {
        PORT: String(ports[id]),
      });
      running.push({ name: id, process });
      await observe({ phase: 'service', name: id, status: 'starting', port: ports[id] });
      const url = new URL(substitute(service.readiness.http, ports));
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        throw new Error('Service readiness must use loopback HTTP.');
      const deadline = Date.now() + service.readiness.timeout_seconds * 1000;
      let ready = false;
      while (
        Date.now() < deadline &&
        !options.signal?.aborted &&
        process.child.nodeChildProcess.exitCode === null
      ) {
        try {
          ready = (await fetch(url, { signal: AbortSignal.timeout(300), redirect: 'error' })).ok;
        } catch {
          /* Await startup; never probe remote endpoints. */
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) throw new Error(`Service ${id} readiness failed, timed out, or was cancelled.`);
      await observe({ phase: 'service', name: id, status: 'ready', port: ports[id] });
    }
    result = await runDeclared(root, manifest, command, { ...options, ports });
  } catch (error) {
    failure = error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    for (const id of [...setup].reverse()) {
      const cleanup = manifest.services[id]!.cleanup;
      if (cleanup) {
        try {
          const result = await runDeclared(root, manifest, cleanup, { ports, observe });
          if (result.status !== 'passed') {
            teardownFailed = true;
            await observe({ phase: 'service', name: id, status: 'cleanup_failed' });
          }
        } catch {
          teardownFailed = true;
          await observe({ phase: 'service', name: id, status: 'cleanup_failed' });
        }
      }
    }
    for (const item of running.reverse()) {
      try {
        await item.process.stop();
      } catch {
        teardownFailed = true;
      }
      await item.process.settled.catch(() => {});
      await observe({ phase: 'service', name: item.name, status: 'stopped' });
    }
    for (const reservation of reservations.values()) await reservation.release();
  }
  if (teardownFailed)
    throw new Error(
      'Service teardown is incomplete or fixture cleanup failed; inspect service events before retrying.',
      { cause: failure },
    );
  if (failure) throw failure;
  return result!;
}
