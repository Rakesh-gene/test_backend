import { test, expect } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@kode/storage';
import { Workspace } from '@kode/workspace';
import { telemetry } from '@kode/observability';
import type { CodexConnection } from '@kode/providers';
import { Agents } from '../apps/runner/src/agents.js';

test('adapter validates native profile/model, relays structured answers and file denial, and preserves separate tool outcomes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-agent-'));
  const workspace = new Workspace(home);
  await workspace.init();
  await mkdir(join(workspace.state, 'control'));
  const repo = join(home, 'repo');
  await mkdir(repo);
  await workspace.add(repo, 'repo', 'read');
  const store = new Store(join(workspace.state, 'state.sqlite'));
  await store.ready;
  const otel = telemetry({ quietLogs: true });
  const received: unknown[] = [];
  let mode = 'question';
  const create = () => {
    const connection = {
      onRequest: undefined as CodexConnection['onRequest'],
      onNotification: undefined as CodexConnection['onNotification'],
      initialize: async () => ({}),
      close: () => {},
      request: async (method: string, params: unknown) => {
        if (method === 'model/list')
          return {
            data: [
              {
                id: 'model',
                model: 'model',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              },
            ],
          };
        if (method === 'thread/start') {
          expect(JSON.stringify(params)).toContain(
            join(workspace.state, 'control').replaceAll('\\', '\\\\'),
          );
          return {
            thread: { id: 'thread' },
            model: 'model',
            activePermissionProfile: { id: 'kode-assignment' },
          };
        }
        if (method === 'turn/start') {
          const current = mode;
          setTimeout(() => {
            void (async () => {
              const native =
                current === 'question'
                  ? 'item/tool/requestUserInput'
                  : current === 'permissions'
                    ? 'item/permissions/requestApproval'
                    : 'item/fileChange/requestApproval';
              const detail =
                current === 'question'
                  ? {
                      questions: [
                        {
                          id: 'q',
                          header: 'Choice',
                          question: 'Which one?',
                          isOther: false,
                          options: [{ label: 'One', description: 'First' }],
                        },
                      ],
                    }
                  : current === 'permissions'
                    ? { permissions: { fileSystem: { read: [join(workspace.state, 'control')] } } }
                    : {
                        reason: 'A proposed patch',
                        availableDecisions: ['accept', 'decline', 'cancel'],
                      };
              connection.onNotification?.('item/started', {
                threadId: 'thread',
                item: {
                  id: 'item',
                  type: current === 'question' ? 'tool' : 'fileChange',
                  changes: [{ path: 'file.txt', diff: '+proposed' }],
                },
              });
              received.push(
                await connection.onRequest!(
                  native,
                  { threadId: 'thread', turnId: 'turn', itemId: 'item', ...detail },
                  'native-id',
                ),
              );
              connection.onNotification?.('serverRequest/resolved', {
                threadId: 'thread',
                requestId: 'native-id',
              });
              connection.onNotification?.('item/completed', {
                threadId: 'thread',
                item: {
                  id: 'item',
                  type: current,
                  status: current === 'question' ? 'completed' : 'declined',
                },
              });
              connection.onNotification?.('turn/completed', {
                threadId: 'thread',
                turn: { id: 'turn', status: 'completed' },
              });
            })();
          }, 20);
          return { turn: { id: 'turn' } };
        }
        return {};
      },
    };
    return connection as unknown as CodexConnection;
  };
  const agents = new Agents(workspace, store, otel, create);
  const wait = async (condition: () => Promise<boolean>) => {
    for (let n = 0; n < 1000; n++) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Adapter condition timed out');
  };
  try {
    await expect(
      agents.start({ root: 'repo', prompt: 'scope', sandbox: 'workspace-write' }),
    ).rejects.toThrow('isolated writable');
    for (mode of ['question', 'file', 'permissions']) {
      const task = await agents.start({
        root: 'repo',
        prompt: 'fixture',
        model: 'model',
        reasoning: 'low',
      });
      await wait(async () =>
        (await agents.broker.list()).some((r) => r.taskId === task.id && r.state === 'pending'),
      );
      const record = (await agents.broker.list()).find((r) => r.taskId === task.id)!;
      if (mode !== 'question') {
        expect(record.choices).not.toContain('accept');
        await expect(
          agents.broker.decide(record.id, record.version, record.fingerprint, 'accept'),
        ).rejects.toThrow('not supported');
      }
      if (mode === 'question') {
        await expect(
          agents.broker.decide(record.id, record.version, record.fingerprint, 'answer', {
            q: { answers: ['Invalid'] },
          }),
        ).rejects.toThrow('options');
        expect((await agents.broker.list()).find((r) => r.id === record.id)?.state).toBe('pending');
      }
      await agents.broker.decide(
        record.id,
        record.version,
        record.fingerprint,
        mode === 'question' ? 'answer' : 'decline',
        mode === 'question' ? { q: { answers: ['One'] } } : undefined,
      );
      await wait(async () => (await agents.get(task.id)).status === 'completed');
      const final = (await agents.broker.list()).find((r) => r.id === record.id)!;
      expect(final.state).toBe('resolved');
      expect(final.outcome).toBe(mode === 'question' ? 'completed' : 'declined');
      expect(JSON.stringify(final)).not.toContain('"answers":');
    }
    expect(received).toEqual([
      { answers: { q: { answers: ['One'] } } },
      { decision: 'decline' },
      { permissions: {}, scope: 'turn' },
    ]);
    const rejected = await agents.start({
      root: 'repo',
      prompt: 'fixture',
      reasoning: 'unsupported',
    });
    await wait(async () => (await agents.get(rejected.id)).status === 'blocked').catch(
      async (error) => {
        throw new Error(
          `Rejected model assignment: ${JSON.stringify(await agents.get(rejected.id))}`,
          { cause: error },
        );
      },
    );
    expect((await agents.get(rejected.id)).error).toContain('reasoning');
  } finally {
    await agents.stop();
    await store.close();
    await otel.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
