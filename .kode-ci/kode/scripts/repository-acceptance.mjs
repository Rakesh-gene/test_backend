import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { execa } from 'execa';
import {
  Workspace,
  RepoManifest,
  loadManifest,
  prepareEnvironment,
  runDeclared,
  startProcess,
} from '@kode/workspace';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const backend = argument('--backend') ?? process.env.KODE_BACKEND_ROOT;
const frontend = argument('--frontend') ?? process.env.KODE_FRONTEND_ROOT;
if (!backend || !frontend)
  throw new Error(
    'Provide --backend and --frontend checkout paths (or KODE_BACKEND_ROOT / KODE_FRONTEND_ROOT).',
  );
await mkdir('.artifacts', { recursive: true });
const resume = argument('--resume');
const previous = resume
  ? JSON.parse(await readFile('.artifacts/repository-acceptance.json', 'utf8'))
  : undefined;
if (resume && resolve(resume) !== previous.workspace)
  throw new Error('Resume workspace does not match the recorded fixture run.');
const home = resume ? resolve(resume) : await mkdtemp(resolve('.artifacts/repository-workspace-'));
const workspace = new Workspace(home);
await workspace.init();
const report = {
  recordedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  workspace: home,
  status: 'running',
  roots: [],
  commands: [],
  assertions: [],
  teardown: [],
};
const started = [];
const activityState = new Map();
const observe = async (activity) => {
  const key = `${activity.phase}:${activity.id ?? activity.name}`;
  const value = JSON.stringify(activity);
  if (activityState.get(key) !== value) {
    console.log(value);
    activityState.set(key, value);
  }
};
const hashFile = async (path) =>
  readFile(path).then(
    (bytes) => createHash('sha256').update(bytes).digest('hex'),
    () => null,
  );
async function sourceInstallation(path, kind) {
  const files =
    kind === 'npm'
      ? ['package-lock.json', 'node_modules/.package-lock.json']
      : ['src/obj/project.assets.json', 'tests/src.Tests/obj/project.assets.json'];
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await hashFile(join(path, file))])),
  );
}
async function create(name, path, manager) {
  const prior = previous?.roots.find((item) => item.name === name);
  if (prior) {
    const root = await workspace.root(prior.root.id);
    assert.equal(root.path, await realpath(resolve(path)));
    const current = await workspace.capture(root.id);
    assert.equal(current.digest, prior.inputDigest, 'Source changed; start a fresh fixture run.');
    const item = { ...prior, tree: await workspace.tree(prior.tree.id) };
    report.roots.push(item);
    return item;
  }
  const root = await workspace.add(resolve(path), name, 'write');
  const before = await workspace.capture(root.id);
  const installation = await sourceInstallation(root.path, manager);
  const tree = await workspace.createTree(root.id, before.id);
  const revision = await execa('git', ['-C', root.path, 'rev-parse', 'HEAD'], {
    windowsHide: true,
  });
  const item = {
    name,
    root,
    tree,
    revision: revision.stdout,
    inputDigest: before.digest,
    installation,
  };
  report.roots.push(item);
  return item;
}
async function run(item, name) {
  const result = await runDeclared(item.tree.path, await loadManifest(item.tree.path), name, {
    observe,
  });
  report.commands.push({ root: item.name, ...result });
  assert.equal(result.status, 'passed', `${item.name}/${name}: ${result.stderr || result.stdout}`);
}
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function serve(item, name, url) {
  const manifest = await loadManifest(item.tree.path);
  const process = await startProcess(item.tree.path, manifest.commands[name]);
  started.push({ name: item.name, process });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && process.child.nodeChildProcess.exitCode === null) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* Wait for this owned service to become ready. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const output = process.child.nodeChildProcess.exitCode !== null ? await process.settled : null;
  throw new Error(
    `${item.name} readiness failed: ${output ? process.clean(output.stderr || output.stdout) : 'timeout'}`,
  );
}
let failure;
try {
  const api = await create('backend', backend, 'nuget');
  const web = await create('frontend', frontend, 'npm');
  const postgres = await readFile(join(api.tree.path, 'src/Test.Webapi/Test.Webapi.csproj')).then(
    () => true,
    () => false,
  );
  const database = postgres
    ? process.env.ASDS_POSTGRES_CONNECTION_STRING
    : `Data Source=${join(home, 'fixture.db')}`;
  if (!database)
    throw new Error(
      'This backend revision requires an isolated PostgreSQL connection through ASDS_POSTGRES_CONNECTION_STRING.',
    );
  report.database = postgres
    ? 'PostgreSQL (isolated fixture database)'
    : 'SQLite (owned fixture file)';
  const solution = await readFile(join(api.tree.path, 'test_backend.sln'), 'utf8');
  const projects = [...solution.matchAll(/"([^"]+\.csproj)"/g)].map((match) =>
    match[1].replaceAll('\\', '/'),
  );
  const apiPort = await port(),
    webPort = await port();
  const apiUrl = `http://127.0.0.1:${apiPort}`,
    webUrl = `http://127.0.0.1:${webPort}`;
  const apiManifest = {
    version: 1,
    dependencies: { manager: 'nuget', prepare: 'restore', ...(postgres ? { projects } : {}) },
    commands: {
      restore: {
        run: [
          'dotnet',
          'restore',
          'test_backend.sln',
          '-p:NuGetAudit=false',
          ...(postgres ? ['--locked-mode'] : []),
        ],
        timeout_seconds: 300,
      },
      build: { run: ['dotnet', 'build', 'test_backend.sln', '--no-restore'], timeout_seconds: 300 },
      test: {
        run: [
          'dotnet',
          'test',
          'test_backend.sln',
          '--no-build',
          '--no-restore',
          '--logger',
          'trx;LogFileName=kode-tests.trx',
          '--results-directory',
          join(home, 'test-results'),
        ],
        timeout_seconds: 300,
      },
      serve: {
        run: [
          'dotnet',
          'run',
          '--project',
          postgres ? 'src/Test.Webapi/Test.Webapi.csproj' : 'src/src.csproj',
          '--no-build',
          '--no-restore',
          '--no-launch-profile',
          '--urls',
          apiUrl,
        ],
        timeout_seconds: 300,
        env: {
          ASPNETCORE_ENVIRONMENT: 'Development',
          ConnectionStrings__DefaultConnection: database,
        },
      },
    },
  };
  if (postgres) apiManifest.commands.test.env = { ASDS_POSTGRES_CONNECTION_STRING: database };
  const webManifest = {
    version: 1,
    dependencies: { manager: 'npm', prepare: 'install', validate: 'health' },
    commands: {
      install: { run: ['npm', 'ci', '--no-audit', '--no-fund'], timeout_seconds: 300 },
      health: { run: ['npm', 'run', 'build'], timeout_seconds: 180 },
      build: { run: ['npm', 'run', 'build'], timeout_seconds: 180 },
      lint: {
        run: ['npm', 'run', 'lint'],
        env: { ESLINT_USE_FLAT_CONFIG: 'false' },
        timeout_seconds: 180,
      },
      serve: {
        run: [
          'npm',
          'run',
          'dev',
          '--',
          '--host',
          '127.0.0.1',
          '--port',
          String(webPort),
          '--strictPort',
        ],
        timeout_seconds: 300,
        env: { VITE_API_PROXY_TARGET: apiUrl },
      },
    },
  };
  const webPackage = JSON.parse(await readFile(join(web.tree.path, 'package.json'), 'utf8'));
  if (webPackage.scripts.test)
    webManifest.commands.test = { run: ['npm', 'test', '--', '--run'], timeout_seconds: 180 };
  for (const [item, manifest] of [
    [api, apiManifest],
    [web, webManifest],
  ]) {
    RepoManifest.parse(manifest);
    await writeFile(join(item.tree.path, 'kode.yaml'), JSON.stringify(manifest, null, 2));
    item.environment = await prepareEnvironment(workspace, item.root.id, {
      treeId: item.tree.id,
      observe,
    });
    item.reused = await prepareEnvironment(workspace, item.root.id, {
      treeId: item.tree.id,
      observe,
    });
    assert.equal(item.reused.installInvocations, 0, 'The second request must not reinstall.');
  }
  await run(api, 'build');
  await run(api, 'test');
  await run(web, 'lint');
  await run(web, 'build');
  if (webManifest.commands.test) await run(web, 'test');
  await serve(api, 'serve', `${apiUrl}/api/user`);
  await serve(web, 'serve', webUrl);
  const html = await (await fetch(webUrl, { signal: AbortSignal.timeout(5000) })).text();
  assert.match(html, /src\/main\.jsx/);
  report.assertions.push('React entrypoint served by the real Vite process');
  const payload = {
    firstName: 'Kode',
    lastName: 'Fixture',
    email: 'kode-acceptance@example.invalid',
    password: 'Kode-Fixture!42',
  };
  let cookie = '';
  async function request(path, method = 'GET', body) {
    const response = await fetch(webUrl + path, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return {
      status: response.status,
      body: await response.text().then((text) => (text ? JSON.parse(text) : null)),
    };
  }
  const created = await request('/api/user/register', 'POST', payload);
  assert.equal(created.status, 201);
  assert.equal(created.body.email, payload.email);
  assert.ok(Number.isInteger(created.body.id));
  assert.ok(!JSON.stringify(created.body).toLowerCase().includes('password'));
  if (postgres) {
    assert.equal((await request('/api/auth/session')).status, 401);
    assert.equal(
      (await request('/api/auth/login', 'POST', { email: payload.email, password: 'incorrect' }))
        .status,
      401,
    );
    assert.equal(
      (
        await request('/api/auth/login', 'POST', {
          email: payload.email,
          password: payload.password,
        })
      ).status,
      200,
    );
    assert.equal((await request('/api/auth/session')).body.user.id, created.body.id);
    assert.equal((await request('/api/auth/logout', 'POST')).status, 204);
    cookie = '';
    assert.equal((await request('/api/auth/session')).status, 401);
    report.assertions.push(
      'Anonymous/invalid auth rejected; login/session/logout round trip succeeds',
    );
  }
  assert.equal((await request('/api/user/register', 'POST', payload)).status, 409);
  assert.equal(
    (
      await request('/api/user/register', 'POST', {
        ...payload,
        email: 'invalid',
        password: 'short',
      })
    ).status,
    400,
  );
  const updated = await request(`/api/user/${created.body.id}`, 'PUT', {
    firstName: 'Kode',
    lastName: 'Updated',
    email: payload.email,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.lastName, 'Updated');
  const fetched = await request(`/api/user/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.lastName, 'Updated');
  const listed = await request('/api/user?search=' + encodeURIComponent(payload.email));
  assert.equal(listed.status, 200);
  assert.ok(listed.body.items.some((item) => item.id === created.body.id));
  report.assertions.push(
    `Frontend proxy reaches the real ${postgres ? 'PostgreSQL' : 'SQLite'}-backed API`,
    'Registration returns 201 and excludes credentials',
    'Duplicate email returns 409',
    'Invalid registration returns 400',
    'Update/get/list round trip preserves the expected user',
  );
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = String(error);
} finally {
  for (const item of started.reverse()) {
    try {
      await item.process.stop();
      await item.process.settled;
      report.teardown.push({ name: item.name, status: 'stopped' });
    } catch {
      report.teardown.push({ name: item.name, status: 'failed' });
      report.status = 'failed';
    }
  }
  for (const item of report.roots) {
    try {
      const after = await workspace.capture(item.root.id);
      assert.equal(after.digest, item.inputDigest, 'Original source changed.');
      assert.deepEqual(
        await sourceInstallation(item.root.path, item.name === 'backend' ? 'nuget' : 'npm'),
        item.installation,
      );
      item.sourcePreserved = true;
      await workspace.retain(item.tree.id);
    } catch (error) {
      item.sourcePreserved = false;
      report.status = 'failed';
      failure ??= error;
    }
  }
  await writeFile('.artifacts/repository-acceptance.json', JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    report: '.artifacts/repository-acceptance.json',
    status: report.status,
    assertions: report.assertions.length,
  }),
);
if (failure || report.status !== 'passed') process.exitCode = 1;
