import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = process.argv[process.argv.indexOf('--provider') + 1];
if (!['claude', 'copilot'].includes(provider))
  throw new Error('Select --provider claude or --provider copilot explicitly.');
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined;
const cwd = await mkdtemp(join(tmpdir(), 'kode-live-'));
const command = 'node -e "process.stdout.write(\'KODE_P00_PERMISSION\')"';
const permissionPrompt = `Use the shell tool once to run exactly ${command}. Do not edit files or access network. If denied, stop and report DENIED. Otherwise report DONE.`;
const report = {
  provider,
  platform: process.platform,
  arch: process.arch,
  recordedAt: new Date().toISOString(),
  scenarios: [],
};
async function scenario(name, action) {
  try {
    report.scenarios.push({ name, status: 'pass', result: await action() });
  } catch (error) {
    report.scenarios.push({ name, status: 'fail', error: String(error) });
  }
}
try {
  if (provider === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY) {
      report.blocked =
        'Configure an approved ANTHROPIC_API_KEY locally; consumer login is not assumed portable.';
    } else {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      for (const mode of ['read-only', 'approve', 'deny'])
        await scenario(mode, async () => {
          let requests = 0,
            markerResult = false,
            completed = false;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60000);
          const events = [];
          const run = query({
            prompt:
              mode === 'read-only'
                ? 'Reply exactly KODE_P00_READY. Do not invoke tools.'
                : permissionPrompt,
            options: {
              cwd,
              ...(model ? { model } : {}),
              tools: mode === 'read-only' ? [] : ['Bash'],
              allowedTools: [],
              maxTurns: 4,
              maxBudgetUsd: 0.25,
              permissionMode: 'default',
              abortController: controller,
              canUseTool: async (tool, input) => {
                requests++;
                const exact = tool === 'Bash' && input.command?.trim() === command;
                return mode === 'approve' && exact
                  ? { behavior: 'allow', updatedInput: input }
                  : {
                      behavior: 'deny',
                      message: 'Controlled fixture denial. Stop without retrying.',
                    };
              },
            },
          });
          try {
            for await (const event of run) {
              events.push(event.type);
              for (const item of event.message?.content ?? [])
                if (
                  item.type === 'tool_result' &&
                  !item.is_error &&
                  JSON.stringify(item.content).includes('KODE_P00_PERMISSION')
                )
                  markerResult = true;
              if (event.type === 'result') {
                completed = event.subtype === 'success';
                if (mode === 'read-only' && !event.result?.includes('KODE_P00_READY'))
                  throw new Error('Missing completion marker.');
              }
            }
            if (!completed)
              throw new Error('Claude did not complete the bounded probe successfully.');
            if (mode !== 'read-only' && !requests)
              throw new Error('No native permission callback; routing was not established.');
            if (mode === 'approve' && !markerResult)
              throw new Error('Approved marker command did not execute successfully.');
            if (mode === 'deny' && markerResult) throw new Error('Denied marker command executed.');
            return { requests, markerResult, eventTypes: [...new Set(events)] };
          } finally {
            clearTimeout(timer);
            run.close();
          }
        });
    }
  } else {
    const { CopilotClient } = await import('@github/copilot-sdk');
    const client = new CopilotClient({ workingDirectory: cwd });
    try {
      await client.start();
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated)
        report.blocked = 'Configure a Copilot-entitled token or sign in locally.';
      else {
        const models = await client.listModels();
        report.models = models.map((m) => ({
          id: m.id,
          reasoning: m.capabilities?.supports?.reasoningEffort,
        }));
        for (const mode of ['read-only', 'approve', 'deny'])
          await scenario(mode, async () => {
            let requests = 0,
              markerResult = false;
            const eventTypes = new Set();
            const session = await client.createSession({
              ...(model ? { model } : {}),
              workingDirectory: cwd,
              availableTools:
                mode === 'read-only' ? [] : [process.platform === 'win32' ? 'powershell' : 'bash'],
              onPermissionRequest: (request) => {
                requests++;
                const exact =
                  request.kind === 'shell' && request.fullCommandText?.trim() === command;
                return mode === 'approve' && exact
                  ? { kind: 'approve-once' }
                  : { kind: 'denied-interactively-by-user' };
              },
            });
            session.on((event) => {
              eventTypes.add(event.type);
              if (
                event.type === 'tool.execution_complete' &&
                event.data.success &&
                JSON.stringify(event.data.result).includes('KODE_P00_PERMISSION')
              )
                markerResult = true;
            });
            try {
              const response = await session.sendAndWait(
                {
                  prompt:
                    mode === 'read-only'
                      ? 'Reply exactly KODE_P00_READY. Do not invoke tools.'
                      : permissionPrompt,
                },
                60000,
              );
              if (mode === 'read-only' && !response?.data.content.includes('KODE_P00_READY'))
                throw new Error('Missing completion marker.');
              if (mode !== 'read-only' && !requests)
                throw new Error('No native permission callback; routing was not established.');
              if (mode === 'approve' && !markerResult)
                throw new Error('Approved marker command did not execute successfully.');
              if (mode === 'deny' && markerResult)
                throw new Error('Denied marker command executed.');
              return { requests, markerResult, eventTypes: [...eventTypes] };
            } finally {
              await session.abort().catch(() => {});
              await session.disconnect();
            }
          });
      }
    } finally {
      await client.stop();
    }
  }
} catch (error) {
  report.error = String(error);
}
await mkdir('.artifacts', { recursive: true });
await writeFile(`.artifacts/P00-live-${provider}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (report.blocked) process.exitCode = 2;
else if (
  report.error ||
  report.scenarios.length !== 3 ||
  report.scenarios.some((s) => s.status !== 'pass')
)
  process.exitCode = 1;
