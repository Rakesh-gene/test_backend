import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import {
  emptyView,
  projectEvent,
  safeTerminal,
  StoredEvent,
  type ViewState,
} from '@kode/contracts';
import { RunnerClient, ensureRunner } from '@kode/runner';
import type { TelemetryHealth } from '@kode/observability';

const panes = ['Overview', 'Agents', 'Tools', 'Approvals', 'Context', 'Proof', 'Memory'] as const;
export function App({
  initialClient,
  root,
  fixture = false,
}: {
  initialClient: RunnerClient;
  root: string;
  fixture?: boolean;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminal = stdout as NodeJS.WriteStream;
  const [columns, setColumns] = useState(terminal.columns || 100);
  const [pane, setPane] = useState(0);
  const [selection, setSelection] = useState(0);
  const [view, setView] = useState<ViewState>(emptyView);
  const [connection, setConnection] = useState('connecting');
  const [client, setClient] = useState(initialClient);
  const [error, setError] = useState('');
  const [armed, setArmed] = useState<string>();
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryHealth>();
  const [roots, setRoots] = useState<
    { name: string; path: string; access: string; kind: string }[]
  >([]);
  const pending = [...view.approvals.values()].filter((a) => a.state === 'pending');
  useEffect(() => {
    const resize = () => setColumns(terminal.columns || 100);
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout, terminal]);
  useEffect(() => {
    let disposed = false,
      polling = false;
    const state = emptyView();
    let lastHealth = 0;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        let page;
        let pages = 0;
        do {
          page = StoredEvent.array().parse(
            await client.request('events.list', { after: state.cursor, limit: 100 }),
          );
          for (const event of page) projectEvent(state, event);
          pages++;
        } while (!disposed && page.length === 100 && pages < 5);
        const registry = (await client.request('folder.list')) as { roots: typeof roots };
        if (Date.now() - lastHealth >= 2000) {
          const status = (await client.request('status')) as { telemetry?: TelemetryHealth };
          if (!disposed) setTelemetry(status.telemetry);
          lastHealth = Date.now();
        }
        if (!disposed) {
          setRoots(registry.roots);
          setView({ ...state });
          setConnection('connected');
          setError('');
        }
      } catch (e) {
        if (!disposed) {
          setConnection('disconnected');
          setError(String(e));
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 500);
    return () => {
      disposed = true;
      clearInterval(timer);
      client.close();
    };
  }, [client]);
  useInput((input, key) => {
    if (filtering) {
      if (key.return || key.escape) setFiltering(false);
      else if (key.backspace || key.delete) setFilter((s) => s.slice(0, -1));
      else if (!key.ctrl && !key.meta) setFilter((s) => (s + input).slice(0, 80));
      return;
    }
    if (input === 'q') {
      client.close();
      exit();
      return;
    }
    if (input === '/') {
      setFiltering(true);
      return;
    }
    if (key.escape) {
      setArmed(undefined);
      setFilter('');
      return;
    }
    if (key.tab || key.rightArrow || input === 'l') {
      setPane((p) => (p + 1) % panes.length);
      setSelection(0);
      setArmed(undefined);
    }
    if (key.leftArrow || input === 'h') {
      setPane((p) => (p + panes.length - 1) % panes.length);
      setSelection(0);
      setArmed(undefined);
    }
    if (/^[1-7]$/.test(input)) {
      setPane(Number(input) - 1);
      setSelection(0);
      setArmed(undefined);
    }
    if (key.downArrow) {
      setSelection((s) => Math.min(s + 1, Math.max(0, pending.length - 1)));
      setArmed(undefined);
    }
    if (key.upArrow) {
      setSelection((s) => Math.max(0, s - 1));
      setArmed(undefined);
    }
    if (key.return && pane === 3 && pending[selection] && !busy) setArmed(pending[selection]!.id);
    if (armed && pane === 3 && (input === 'y' || input === 'n') && !busy) {
      const approval = pending.find((a) => a.id === armed);
      if (!approval) {
        setArmed(undefined);
        return;
      }
      setBusy(true);
      setMessage('Sending fixture decision…');
      void client
        .request('approval.respond', {
          requestId: armed,
          decision: input === 'y' ? 'approve' : 'deny',
          expectedVersion: approval.version,
        })
        .then(() =>
          setMessage('Fixture decision recorded. No native request or command was executed.'),
        )
        .catch((e) => setMessage(String(e)))
        .finally(() => {
          setBusy(false);
          setArmed(undefined);
        });
    }
    if (input === 'r' && connection === 'disconnected') {
      setMessage('Reconnecting…');
      void ensureRunner(root, fixture)
        .then(setClient)
        .catch((e) => setMessage(String(e)));
    }
  });
  const narrow = columns < 85;
  const events = view.events
    .filter((e) => JSON.stringify(e).toLowerCase().includes(filter.toLowerCase()))
    .slice(-8);
  const title = panes[pane];
  const tasks = [...view.tasks.values()];
  return (
    <Box flexDirection="column" width={Math.max(35, columns - 1)}>
      <Box borderStyle="round" borderColor="magenta" paddingX={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold color="magenta">
            ◆ kode <Text color="white">/ coding workspace</Text>
          </Text>
          <Text dimColor>{safeTerminal(root)}</Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color={connection === 'connected' ? 'green' : 'yellow'}>● {connection}</Text>
          <Text color="yellow">{pending.length} awaiting decision</Text>
        </Box>
      </Box>
      <Text color={fixture ? 'yellow' : 'cyan'}>
        {fixture
          ? ' FIXTURE MODE • simulated agents and tools • no implementation or native approval execution'
          : ' P03 WORKSPACE • repo commands and environments • provider execution arrives in later phases'}
      </Text>
      {telemetry && (
        <Text
          dimColor={!telemetry.enabled}
          color={
            telemetry.traces.dropped +
              telemetry.logs.dropped +
              telemetry.traces.exportFailed +
              telemetry.logs.exportFailed +
              telemetry.metricExportFailures >
            0
              ? 'yellow'
              : undefined
          }
        >
          {telemetry.enabled
            ? ` OTLP export · queued ${telemetry.traces.queued + telemetry.logs.queued}/${telemetry.traces.capacity + telemetry.logs.capacity} · dropped ${telemetry.traces.dropped + telemetry.logs.dropped} · failed ${telemetry.traces.exportFailed + telemetry.logs.exportFailed} · metric failures ${telemetry.metricExportFailures}`
            : ' OTLP export disabled · durable local events remain available'}
        </Text>
      )}
      <Box flexDirection={narrow ? 'column' : 'row'}>
        <Box
          flexDirection={narrow ? 'row' : 'column'}
          flexWrap="wrap"
          borderStyle="round"
          borderColor="gray"
          width={narrow ? undefined : 19}
          paddingX={1}
        >
          {panes.map((name, i) => (
            <Text key={name} color={i === pane ? 'cyan' : 'gray'} bold={i === pane}>
              {i === pane ? '›' : ' '} {i + 1} {name}{' '}
            </Text>
          ))}
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          minHeight={12}
        >
          <Text bold color="cyan">
            {title} {filter ? ` / ${safeTerminal(filter)}` : ''}
          </Text>
          {(pane === 0 || pane === 1) && (
            <>
              {pane === 0 &&
                roots.map((item) => (
                  <Box key={item.name} flexDirection="column">
                    <Text color="cyan">
                      {safeTerminal(item.name)} · {item.kind} · {item.access}
                    </Text>
                    <Text dimColor>{safeTerminal(item.path)}</Text>
                  </Box>
                ))}
              <Text dimColor>AGENT / TASK / STATE</Text>
              {tasks.length ? (
                tasks.map((task) => (
                  <Box key={task.id} flexDirection="column" marginTop={1}>
                    <Text bold>
                      {safeTerminal(task.agent)}{' '}
                      <Text dimColor>({safeTerminal(task.provider)})</Text>
                    </Text>
                    <Text>{safeTerminal(task.title)}</Text>
                    <Text color="yellow">◌ {safeTerminal(task.status)}</Text>
                  </Box>
                ))
              ) : (
                <Text dimColor>
                  No tasks dispatched. Add providers in later phases; use --fixture to inspect the
                  prototype.
                </Text>
              )}
              <Box marginTop={1}>
                <Text dimColor>
                  {view.cursor} durable events · {tasks.length} tasks · {pending.length} pending ·
                  {view.events.length}/200 recent events · no estimated completion
                </Text>
              </Box>
            </>
          )}
          {pane === 2 &&
            events
              .filter((e) => e.kind === 'tool.updated')
              .map((e) => <Text key={e.seq}>{safeTerminal(JSON.stringify(e.data))}</Text>)}
          {pane === 2 && !view.events.some((e) => e.kind === 'tool.updated') && (
            <Text dimColor>No tool calls. Native tool adapters are not connected.</Text>
          )}
          {pane === 3 && (
            <>
              {pending.length ? (
                pending.map((a, i) => (
                  <Box key={a.id} flexDirection="column" marginTop={1}>
                    <Text color={i === selection ? 'cyan' : 'white'}>
                      {i === selection ? '›' : ' '} {safeTerminal(a.command)}
                    </Text>
                    <Text dimColor>
                      {' '}
                      {a.taskId} · {a.fixture ? 'SIMULATED request' : 'native'} · version{' '}
                      {a.version}
                    </Text>
                  </Box>
                ))
              ) : (
                <Text color="green">No pending approvals.</Text>
              )}
              <Text color="yellow">
                {armed
                  ? 'Confirm selected fixture request: y approve / n deny / Esc back'
                  : '↑↓ select · Enter inspect/arm · arriving requests never select a response'}
              </Text>
              {busy && <Text>Delivering decision…</Text>}
            </>
          )}
          {pane === 4 && (
            <>
              <Text dimColor>Generation / scope / precision</Text>
              {view.events
                .filter((e) => e.kind === 'context.updated')
                .map((e) => (
                  <Text key={e.seq}>{safeTerminal(JSON.stringify(e.data))}</Text>
                ))}
              <Text dimColor>Real indexing and freshness arrive in P04/P05.</Text>
            </>
          )}
          {pane === 5 && (
            <>
              <Text dimColor>REQUIREMENT → EXECUTION → EVIDENCE</Text>
              {view.events
                .filter((e) => e.kind === 'proof.updated')
                .map((e) => (
                  <Text key={e.seq}>{safeTerminal(JSON.stringify(e.data))}</Text>
                ))}
              <Text dimColor>
                No behavioral proof has run. Fixture status cannot close a feature.
              </Text>
            </>
          )}
          {pane === 6 && (
            <Text dimColor>
              Shared memory service arrives in P07. No generated findings are presented as facts.
            </Text>
          )}
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        <Text bold>
          Activity <Text dimColor>· bounded recent events</Text>
        </Text>
        {events.slice(-4).map((event) => (
          <Text key={event.seq} dimColor>
            #{event.seq} {event.time.slice(11, 19)} {event.kind} {event.taskId ?? ''}
          </Text>
        ))}
      </Box>
      {error && <Text color="red">{safeTerminal(error)} · r reconnect</Text>}
      {message && <Text color="yellow">{safeTerminal(message)}</Text>}
      <Text dimColor>
        {filtering
          ? `Search: ${safeTerminal(filter)}▌ Enter finish`
          : ' Tab / ←→ panes · 1–7 jump · / filter · Esc clear · q detach (runner stays active)'}
      </Text>
    </Box>
  );
}
