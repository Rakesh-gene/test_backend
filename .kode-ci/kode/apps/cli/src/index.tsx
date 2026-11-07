#!/usr/bin/env node
import React from 'react';
import { Command } from 'commander';
import { render } from 'ink';
import { ensureRunner, RunnerClient, workspacePaths } from '@kode/runner';
import { providerInventory } from '@kode/providers';
import { App } from './app.js';
import type { Request } from '@kode/contracts';
import { telemetry, withTraceContext } from '@kode/observability';

const program = new Command()
  .name('kode')
  .description('A rich terminal workspace for spec- and proof-driven coding.')
  .version('0.1.0');
program
  .option('--root <directory>', 'Workspace root', process.cwd())
  .option('--fixture', 'Explicitly load simulated agent/tool events')
  .option('--json', 'Machine-readable diagnostic output')
  .option('--no-tui', 'Use linear diagnostic output');
program
  .command('doctor')
  .description('Inspect local toolchain and provider availability without inference')
  .option('--json', 'Machine-readable output')
  .action(async (options) => {
    const inventory = {
      schemaVersion: 1,
      node: process.version,
      npmBaseline: '11.19.1',
      platform: process.platform,
      arch: process.arch,
      providers: await providerInventory(),
      phases: {
        P00: 'deferred provider/platform gates',
        P01: 'locally verified foundation',
        P02: 'workspace isolation',
        P03: 'commands and environments',
      },
    };
    process.stdout.write(
      options.json || program.opts().json
        ? JSON.stringify(inventory) + '\n'
        : `Kode doctor\nNode ${inventory.node} · ${inventory.platform}/${inventory.arch}\n${inventory.providers.map((p) => `${p.provider}: ${p.installed ? 'installed' : 'not on PATH'} · auth ${p.authentication}`).join('\n')}\n`,
    );
  });
program
  .command('status')
  .description('Read durable workspace status')
  .option('--json', 'Machine-readable output')
  .action(async (options) => {
    const client = await ensureRunner(program.opts().root);
    try {
      const result = await client.request('status');
      process.stdout.write(
        options.json || program.opts().json
          ? JSON.stringify(result) + '\n'
          : JSON.stringify(result, null, 2) + '\n',
      );
    } finally {
      client.close();
    }
  });
const runnerCommand = program.command('runner').description('Manage the local workspace runner');
async function rpc(method: Request['method'], params: Record<string, unknown> = {}) {
  const client = await ensureRunner(program.opts().root);
  try {
    const result = await client.request(method, params, 60000);
    process.stdout.write(JSON.stringify(result, null, program.opts().json ? undefined : 2) + '\n');
  } finally {
    client.close();
  }
}
program
  .command('init')
  .description('Initialize workspace registration without changing source files')
  .action(() => rpc('workspace.init'));
const folders = program
  .command('folder')
  .description('Register repository and ordinary-folder roots');
folders
  .command('add <path>')
  .requiredOption('--name <name>', 'Unique root name')
  .option('--access <access>', 'read or write scope', 'read')
  .action((path, options) =>
    rpc('folder.add', { path, name: options.name, access: options.access }),
  );
folders.command('list').action(() => rpc('folder.list'));
folders
  .command('remove <root>')
  .description('Unregister; never delete source')
  .action((root) => rpc('folder.remove', { root }));
program
  .command('capture <root>')
  .description('Capture current permitted bytes and Git provenance')
  .action((root) => rpc('baseline.capture', { root }));
const trees = program.command('tree').description('Manage isolated task input trees');
trees
  .command('create <root>')
  .option('--baseline <id>', 'Use a captured baseline')
  .option('--access <access>', 'read or write task scope', 'write')
  .action((root, options) =>
    rpc('tree.create', { root, baseline: options.baseline, access: options.access }),
  );
trees.command('cleanup <tree>').action((tree) => rpc('tree.cleanup', { tree }));
trees
  .command('retain <tree>')
  .description('Retain a tree referenced by accepted evidence')
  .action((tree) => rpc('tree.retain', { tree }));
const repos = program.command('repo').description('Declare and inspect repository commands');
repos
  .command('init <root>')
  .option('--manager <manager>', 'npm, nuget or none', 'none')
  .action((root, options) => rpc('repo.init', { root, manager: options.manager }));
repos
  .command('inspect <root>')
  .option('--tree <id>', 'Inspect task tree configuration')
  .action((root, options) => rpc('repo.inspect', { root, tree: options.tree }));
async function job(
  root: string,
  options: { tree?: string; offline?: boolean; detach?: boolean },
  kind: string,
  command?: string,
) {
  const client = await ensureRunner(program.opts().root);
  let id: string | undefined;
  const cancel = () => {
    if (id) void client.request('job.cancel', { id }).catch(() => {});
  };
  process.once('SIGINT', cancel);
  try {
    const started = (await client.request('job.start', {
      root,
      tree: options.tree,
      offline: options.offline,
      kind,
      command,
    })) as { id: string };
    id = started.id;
    if (options.detach) {
      process.stdout.write(JSON.stringify(started) + '\n');
      return;
    }
    if (!program.opts().json)
      process.stderr.write(`Running ${kind} job ${id}; Ctrl+C requests cancellation.\n`);
    let result: { status: string; [key: string]: unknown };
    do {
      await new Promise((r) => setTimeout(r, 200));
      result = (await client.request('job.get', { id })) as typeof result;
    } while (result.status === 'running');
    process.stdout.write(JSON.stringify(result, null, program.opts().json ? undefined : 2) + '\n');
    if (result.status !== 'passed') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    client.close();
  }
}
const commands = program
  .command('command')
  .description('Execute named kode.yaml commands literally');
commands
  .command('run <root> <command>')
  .option('--tree <id>', 'Run in an isolated task tree')
  .option('--detach', 'Return a durable job ID without waiting')
  .action((root, command, options) => job(root, options, 'command', command));
const environments = program
  .command('env')
  .description('Inspect or prepare reusable npm/NuGet environments');
environments
  .command('inspect <root>')
  .option('--tree <id>', 'Inspect task environment')
  .action((root, options) => rpc('env.inspect', { root, tree: options.tree }));
environments
  .command('prepare <root>')
  .option('--tree <id>', 'Prepare a Kode-owned target')
  .option('--offline', 'Use only available manager caches')
  .option('--detach', 'Return a durable job ID')
  .action((root, options) => job(root, options, 'environment'));
const jobs = program
  .command('job')
  .description('Inspect or cancel durable command/environment jobs');
jobs.command('show <id>').action((id) => rpc('job.get', { id }));
jobs.command('cancel <id>').action((id) => rpc('job.cancel', { id }));
runnerCommand.command('start').action(async () => {
  const client = await ensureRunner(program.opts().root, program.opts().fixture);
  try {
    process.stdout.write(JSON.stringify(await client.request('ping')) + '\n');
  } finally {
    client.close();
  }
});
runnerCommand.command('stop').action(async () => {
  const client = await RunnerClient.connect(await workspacePaths(program.opts().root));
  try {
    process.stdout.write(JSON.stringify(await client.request('shutdown')) + '\n');
  } finally {
    client.close();
  }
});
program.action(async () => {
  const options = program.opts();
  const client = await ensureRunner(options.root, options.fixture);
  if (options.fixture) await client.request('fixture.load');
  if (options.json || !options.tui || !process.stdout.isTTY || !process.stdin.isTTY) {
    try {
      process.stdout.write(JSON.stringify(await client.request('status')) + '\n');
    } finally {
      client.close();
    }
    return;
  }
  const ui = render(<App initialClient={client} root={options.root} fixture={options.fixture} />, {
    exitOnCtrlC: true,
  });
  try {
    await ui.waitUntilExit();
  } finally {
    client.close();
  }
});
const cliTelemetry = telemetry({ quietLogs: true });
try {
  await withTraceContext(
    { traceparent: process.env.TRACEPARENT, tracestate: process.env.TRACESTATE },
    () =>
      cliTelemetry.operation('cli.command', async () => {
        await program.parseAsync();
      }),
  );
} catch (error) {
  const options = program.opts();
  if (options.json || process.argv.includes('--json'))
    process.stdout.write(
      JSON.stringify({ error: { code: 'KODE_ERROR', message: String(error) } }) + '\n',
    );
  else process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await cliTelemetry.close();
}
