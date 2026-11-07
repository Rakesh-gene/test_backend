import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { format } from 'prettier';
import { RpcRequest, RpcResponse, EventInput, StoredEvent } from '@kode/contracts';
import { RepoManifest } from '@kode/workspace';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({
  'rpc-request': RpcRequest,
  'rpc-response': RpcResponse,
  'event-input': EventInput,
  'stored-event': StoredEvent,
  kode: RepoManifest,
}))
  await writeFile(
    `schemas/${name}.schema.json`,
    await format(JSON.stringify(z.toJSONSchema(schema)), { parser: 'json', printWidth: 100 }),
  );
