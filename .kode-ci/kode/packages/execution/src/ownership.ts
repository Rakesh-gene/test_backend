import koffi from 'koffi';
import { fileURLToPath } from 'node:url';

/** A non-inheritable handle: runner death closes the last handle and kills the job. */
export function windowsOwnership() {
  if (process.platform !== 'win32') return undefined;
  if (!['x64', 'arm64'].includes(process.arch))
    throw new Error('Process ownership requires a supported 64-bit Windows runtime.');
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void * __stdcall CreateJobObjectW(void *, void *)');
  const configure = kernel.func(
    'int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)',
  );
  const open = kernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)');
  const assign = kernel.func('int __stdcall AssignProcessToJobObject(void *, void *)');
  const terminate = kernel.func('int __stdcall TerminateJobObject(void *, uint32_t)');
  const close = kernel.func('int __stdcall CloseHandle(void *)');
  const job: unknown = create(null, null);
  if (!job) throw new Error('Cannot create owned Windows process job. No command dispatched.');
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!configure(job, 9, limits, limits.length)) {
    close(job);
    throw new Error('Cannot enforce Windows job lifetime. No command dispatched.');
  }
  let closed = false;
  return {
    assign(pid: number) {
      const child: unknown = open(0x0100 | 0x0001, 0, pid);
      if (!child) throw new Error('Cannot open blocked command host. No command dispatched.');
      try {
        if (!assign(job, child))
          throw new Error('Cannot contain blocked command host. No command dispatched.');
      } finally {
        close(child);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      // This targets a kernel object, never a recycled PID or a process-name match.
      const stopped = terminate(job, 1);
      close(job);
      if (!stopped) throw new Error('Windows refused owned job termination.');
    },
  };
}
export const commandHost = fileURLToPath(new URL('./command-host.js', import.meta.url));
