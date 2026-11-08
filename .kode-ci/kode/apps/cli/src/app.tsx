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
type NativeQuestion = {
  id: string;
  question: string;
  options?: { label: string }[] | null;
  isOther?: boolean;
  isSecret?: boolean;
};
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
  const [answering, setAnswering] = useState<{
    id: string;
    version: number;
    fingerprint: string;
    questions: NativeQuestion[];
    index: number;
    text: string;
    answers: Record<string, { answers: string[] }>;
  }>();
  const [details, setDetails] = useState<string>();
  const [detailPage, setDetailPage] = useState(0);
  const [telemetry, setTelemetry] = useState<TelemetryHealth>();
  const [boundary, setBoundary] = useState<string>();
  const [roots, setRoots] = useState<
    { name: string; path: string; access: string; kind: string }[]
  >([]);
  const pending = [...view.approvals.values()].filter((a) => a.state === 'pending');
  const armedChoices = pending.find((a) => a.id === armed)?.native?.choices ?? [];
  const nativeActions = [
    armedChoices.includes('accept') ? 'y approve once' : '',
    armedChoices.includes('decline')
      ? 'n deny'
      : armedChoices.includes('cancel')
        ? 'n deny by cancelling turn'
        : '',
    armedChoices.includes('cancel') ? 'x cancel' : '',
    'Esc defer',
  ]
    .filter(Boolean)
    .join(' / ');
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
          const status = (await client.request('status')) as {
            telemetry?: TelemetryHealth;
            execution?: { commands: { summary: string } };
          };
          if (!disposed) {
            setTelemetry(status.telemetry);
            setBoundary(status.execution?.commands.summary);
          }
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
    if (answering) {
      if (key.escape) {
        setAnswering(undefined);
        return;
      }
      if (key.return) {
        const question = answering.questions[answering.index]!;
        const chosen = question.options?.[Number(answering.text) - 1]?.label ?? answering.text;
        if (
          !chosen ||
          (question.options?.length &&
            !question.isOther &&
            !question.options.some((option) => option.label === chosen))
        ) {
          setMessage('Choose an offered option number or label.');
          return;
        }
        const answers = { ...answering.answers, [question.id]: { answers: [chosen] } };
        if (answering.index + 1 < answering.questions.length) {
          setAnswering({ ...answering, index: answering.index + 1, text: '', answers });
          return;
        }
        setBusy(true);
        void client
          .request('approval.decide', {
            id: answering.id,
            version: answering.version,
            fingerprint: answering.fingerprint,
            choice: 'answer',
            answers,
          })
          .then(() => setMessage('Answers recorded for delivery; native resolution is separate.'))
          .catch((error) => setMessage(String(error)))
          .finally(() => {
            setBusy(false);
            setAnswering(undefined);
            setArmed(undefined);
          });
        return;
      }
      if (key.backspace || key.delete)
        setAnswering({ ...answering, text: answering.text.slice(0, -1) });
      else if (!key.ctrl && !key.meta)
        setAnswering({ ...answering, text: (answering.text + input).slice(0, 4096) });
      return;
    }
    if (details && (input === 'j' || key.pageDown)) {
      setDetailPage((page) => page + 1);
      return;
    }
    if (details && (input === 'k' || key.pageUp)) {
      setDetailPage((page) => Math.max(0, page - 1));
      return;
    }
    if (pane === 3 && input === 'd') {
      setDetails(details ? undefined : pending[selection]?.id);
      setDetailPage(0);
      return;
    }
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
    if (key.return && pane === 3 && pending[selection] && !busy) {
      const selected = pending[selection]!;
      if (selected.native?.kind === 'question') {
        const questions = JSON.parse(selected.native.details).questions as NativeQuestion[];
        if (!questions?.length) {
          setMessage('Native question has no supported fields. Cancel this invocation.');
          return;
        }
        setAnswering({
          id: selected.id,
          version: selected.version,
          fingerprint: selected.native.fingerprint,
          questions,
          index: 0,
          text: '',
          answers: {},
        });
      } else setArmed(selected.id);
    }
    if (armed && pane === 3 && ['y', 'n', 'x'].includes(input) && !busy) {
      const approval = pending.find((a) => a.id === armed);
      if (!approval) {
        setArmed(undefined);
        return;
      }
      setBusy(true);
      setMessage(
        approval.fixture
          ? 'Sending fixture decision…'
          : 'Recording native decision; delivery and tool outcome are separate.',
      );
      if (approval.native) {
        const choice =
          input === 'y'
            ? 'accept'
            : input === 'n' && approval.native.choices.includes('decline')
              ? 'decline'
              : 'cancel';
        if (!approval.native.choices.includes(choice)) {
          setBusy(false);
          setMessage('This choice is not supported. Inspect the native request.');
          return;
        }
        void client
          .request('approval.decide', {
            id: approval.id,
            version: approval.version,
            fingerprint: approval.native.fingerprint,
            choice,
          })
          .then(() =>
            setMessage(
              'Native decision recorded; awaiting native acknowledgement and actual tool outcome.',
            ),
          )
          .catch((error) => setMessage(String(error)))
          .finally(() => {
            setBusy(false);
            setArmed(undefined);
          });
        return;
      }
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
          : ' WORKSPACE • Codex native assignments • repo commands and environments'}
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
              {pane === 0 && boundary && <Text dimColor>Repo commands: {boundary}</Text>}
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
                  No tasks dispatched. Use kode agent start to create a Codex assignment.
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
                      {a.taskId} ·{' '}
                      {a.fixture ? 'SIMULATED request' : `native ${a.native?.kind ?? ''}`} · version{' '}
                      {a.version}
                    </Text>
                    {a.native && (
                      <>
                        <Text>{safeTerminal(a.native.cwd)}</Text>
                        <Text>{safeTerminal(a.native.reason)}</Text>
                        <Text>
                          Choices: {a.native.choices.join(', ')} · one invocation / turn only
                        </Text>
                        <Text dimColor>Inspect full scope: kode approval inspect {a.id}</Text>
                        <Text dimColor>
                          d inspect in CLI · j/k detail pages · fingerprint{' '}
                          {a.native.fingerprint.slice(0, 12)}
                        </Text>
                      </>
                    )}
                  </Box>
                ))
              ) : (
                <Text color="green">No pending approvals.</Text>
              )}
              <Text color="yellow">
                {armed
                  ? pending.find((a) => a.id === armed)?.fixture
                    ? 'Confirm selected fixture request: y approve / n deny / Esc back'
                    : `Confirm native request: ${nativeActions}`
                  : '↑↓ select · Enter inspect/arm · arriving requests never select a response'}
              </Text>
              {busy && <Text>Delivering decision…</Text>}
              {details && (
                <Box flexDirection="column" borderStyle="single">
                  <Text>Native request details · page {detailPage + 1} · j/k pages · d close</Text>
                  {(
                    safeTerminal(
                      JSON.stringify(view.approvals.get(details)?.native, null, 2),
                    ).match(new RegExp(`.{1,${Math.max(20, columns - 12)}}`, 'g')) ?? []
                  )
                    .slice(detailPage * 8, (detailPage + 1) * 8)
                    .map((line, index) => (
                      <Text key={index}>{line}</Text>
                    ))}
                </Box>
              )}
              {answering && (
                <Box flexDirection="column" borderStyle="single">
                  <Text>{safeTerminal(answering.questions[answering.index]!.question)}</Text>
                  {answering.questions[answering.index]!.options?.map((option, index) => (
                    <Text key={index}>
                      {index + 1}. {safeTerminal(option.label)}
                    </Text>
                  ))}
                  <Text>
                    Answer:{' '}
                    {answering.questions[answering.index]!.isSecret
                      ? '•'.repeat(answering.text.length)
                      : safeTerminal(answering.text)}
                    ▌
                  </Text>
                  <Text>Enter next/send · Esc defer without answering</Text>
                </Box>
              )}
              {[...view.approvals.values()]
                .filter((a) => a.native && a.state !== 'pending')
                .slice(-4)
                .map((a) => (
                  <Text key={a.id} color={a.state === 'delivery_unknown' ? 'yellow' : undefined}>
                    {a.id.slice(0, 8)} · {a.state} · {a.native?.delivery} · tool:{' '}
                    {a.native?.outcome ?? 'not observed'}
                  </Text>
                ))}
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
