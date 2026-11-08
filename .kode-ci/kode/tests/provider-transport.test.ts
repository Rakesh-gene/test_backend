import { test, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConnection } from '@kode/providers';

test('native string request IDs are delivered exactly once and changed duplicate operations close the transport', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-transport-'));
  let connection: CodexConnection | undefined;
  try {
    const script = join(home, 'native.cjs');
    await writeFile(
      script,
      `
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let replies=0;
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='duplicate'){
  send({id:m.id,result:{}});
  const request={id:'native-string',method:'item/commandExecution/requestApproval',params:{command:'same invocation'}};
  send(request);send(request);
 }
 if(m.id==='native-string'){
  replies++;send({method:'serverRequest/resolved',params:{requestId:m.id,replies,decision:m.result.decision}});
 }
 if(m.method==='changed'){
  send({id:'native-string',method:'item/commandExecution/requestApproval',params:{command:'changed invocation'}});
 }
});`,
    );
    connection = new CodexConnection(process.execPath, [script]);
    let requests = 0;
    connection.onRequest = async (_method, _params, id) => {
      expect(id).toBe('native-string');
      requests++;
      await new Promise((r) => setTimeout(r, 20));
      return { decision: 'cancel' };
    };
    await connection.initialize();
    await connection.request('duplicate');
    for (let n = 0; n < 100 && !connection.notifications.length; n++)
      await new Promise((r) => setTimeout(r, 10));
    expect(requests).toBe(1);
    expect(connection.notifications).toEqual([
      {
        method: 'serverRequest/resolved',
        params: { requestId: 'native-string', replies: 1, decision: 'cancel' },
      },
    ]);
    await expect(connection.request('changed')).rejects.toThrow('connection closed');
  } finally {
    connection?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
