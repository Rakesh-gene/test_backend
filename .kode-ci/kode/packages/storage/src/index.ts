import { Worker } from 'node:worker_threads';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventInput, StoredEvent, redact, type KodeEvent } from '@kode/contracts';

export class Store {
  private worker: Worker;
  private next = 0;
  private available = true;
  private exited: Promise<void>;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<void>;
  constructor(path: string, options: { failMigration?: boolean } = {}) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { path, ...options },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    });
    this.exited = new Promise((resolve) => this.worker.once('exit', () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (message) => {
        if (message.ready) {
          resolve();
          return;
        }
        if (message.startupError) {
          this.available = false;
          reject(new Error(message.startupError));
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      });
      this.worker.on('error', (e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        reject(error);
        this.fail(error);
      });
      this.worker.on('exit', (code) => {
        const error = new Error(`Storage worker exited (${code}).`);
        reject(error);
        this.fail(error);
      });
    });
  }
  private fail(error: Error) {
    this.available = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async call(method: string, data: Record<string, unknown> = {}): Promise<unknown> {
    await this.ready;
    if (!this.available) throw new Error('Storage worker is closed or unavailable.');
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, data });
    });
  }
  async append(input: unknown, secrets: string[] = []): Promise<KodeEvent> {
    return StoredEvent.parse(await this.call('append', EventInput.parse(redact(input, secrets))));
  }
  async list(after = 0, limit = 100): Promise<KodeEvent[]> {
    return StoredEvent.array().parse(await this.call('list', { after, limit }));
  }
  async decision(requestId: string, decision: string, expectedVersion: number) {
    return this.call('approve', { requestId, decision, expectedVersion, eventId: randomUUID() });
  }
  async close() {
    if (!this.available) return;
    try {
      await this.call('close');
    } finally {
      this.available = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              void this.worker.terminate().then(() => resolve());
            }, 3000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  async terminate() {
    this.available = false;
    await this.worker.terminate();
  }
}

export async function putArtifact(
  directory: string,
  content: Uint8Array,
): Promise<{ id: string; path: string }> {
  const id = createHash('sha256').update(content).digest('hex');
  const path = join(directory, id.slice(0, 2), id);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!Buffer.from(await readFile(path)).equals(content))
      throw new Error('Artifact checksum collision or corrupted storage.', { cause: error });
  }
  return { id, path };
}
