import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { EventInput } from '@kode/contracts';

let db: Database.Database;
try {
  db = new Database(workerData.path as string);
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 1)
    throw new Error(
      `Unsupported database schema ${version}; use a compatible Kode version or restore a backup.`,
    );
  if (version === 0)
    db.transaction(() => {
      db.exec(
        'CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL, time TEXT NOT NULL); CREATE TABLE approvals(id TEXT PRIMARY KEY, decision TEXT, version INTEGER NOT NULL DEFAULT 1);',
      );
      if (workerData.failMigration)
        throw new Error('Injected migration failure; transaction rolled back.');
      db.pragma('user_version = 1');
    })();
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  parentPort!.postMessage({ ready: true });
} catch (error) {
  parentPort!.postMessage({ startupError: String(error) });
}

parentPort!.on(
  'message',
  (message: { id: number; method: string; data: Record<string, unknown> }) => {
    try {
      let result: unknown;
      switch (message.method) {
        case 'append': {
          const input = EventInput.parse(message.data);
          const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(input.id) as
            { kind: string; task_id: string | null; data: string } | undefined;
          if (
            existing &&
            (existing.kind !== input.kind ||
              existing.task_id !== (input.taskId ?? null) ||
              existing.data !== JSON.stringify(input.data))
          )
            throw new Error('Event ID already exists with different content.');
          db.prepare(
            'INSERT OR IGNORE INTO events(id,kind,task_id,data,time) VALUES(?,?,?,?,?)',
          ).run(
            input.id,
            input.kind,
            input.taskId ?? null,
            JSON.stringify(input.data),
            new Date().toISOString(),
          );
          result = mapEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(input.id) as Row);
          break;
        }
        case 'list':
          result = (
            db
              .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
              .all(message.data.after, message.data.limit) as Row[]
          ).map(mapEvent);
          break;
        case 'approve':
          result = db.transaction(() => {
            const { requestId, decision, expectedVersion } = message.data;
            const found = db
              .prepare('SELECT id FROM events WHERE kind = ? AND json_extract(data, ?) = ?')
              .get('approval.requested', '$.id', requestId);
            if (!found) throw new Error('Unknown approval request.');
            db.prepare('INSERT OR IGNORE INTO approvals(id) VALUES(?)').run(requestId);
            const update = db
              .prepare(
                'UPDATE approvals SET decision = ?, version = version + 1 WHERE id = ? AND version = ? AND decision IS NULL',
              )
              .run(decision, requestId, expectedVersion);
            if (update.changes !== 1)
              throw new Error('Approval is already resolved or its version changed.');
            db.prepare('INSERT INTO events(id,kind,data,time) VALUES(?,?,?,?)').run(
              message.data.eventId,
              'approval.resolved',
              JSON.stringify({
                requestId,
                decision,
                fixture: true,
                delivery: 'local-fixture-only',
              }),
              new Date().toISOString(),
            );
            return { decision, delivered: false, fixture: true };
          })();
          break;
        case 'slow':
          result = db
            .prepare(
              'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT sum(x) AS total FROM n',
            )
            .get();
          break;
        case 'count':
          result = db
            .prepare('SELECT count(*) AS events, COALESCE(max(seq),0) AS cursor FROM events')
            .get();
          break;
        case 'countDecision':
          result = (
            db
              .prepare(
                'SELECT count(*) AS count FROM events WHERE kind = ? AND json_extract(data, ?) = ?',
              )
              .get('approval.resolved', '$.requestId', message.data.requestId) as { count: number }
          ).count;
          break;
        case 'appendGroupIfAbsent':
          result = db.transaction(() => {
            if (
              db.prepare('SELECT id FROM events WHERE task_id = ? LIMIT 1').get(message.data.taskId)
            )
              return false;
            const inputs = EventInput.array().max(20).parse(message.data.inputs);
            for (const input of inputs)
              db.prepare('INSERT INTO events(id,kind,task_id,data,time) VALUES(?,?,?,?,?)').run(
                input.id,
                input.kind,
                input.taskId ?? null,
                JSON.stringify(input.data),
                new Date().toISOString(),
              );
            return true;
          })();
          break;
        case 'close':
          db.close();
          result = true;
          break;
        default:
          throw new Error('Unknown storage operation.');
      }
      parentPort!.postMessage({ id: message.id, result });
    } catch (error) {
      parentPort!.postMessage({ id: message.id, error: String(error) });
    }
  },
);
interface Row {
  seq: number;
  id: string;
  kind: string;
  task_id: string | null;
  data: string;
  time: string;
}
function mapEvent(row: Row) {
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    data: JSON.parse(row.data),
    time: row.time,
  };
}
