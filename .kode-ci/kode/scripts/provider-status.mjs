import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { CopilotClient } from '@github/copilot-sdk';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'kode-provider-status-'));
const result = {
  platform: process.platform,
  arch: process.arch,
  recordedAt: new Date().toISOString(),
  claude: {},
  copilot: {},
};
try {
  const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  const sdk = JSON.parse(await readFile(join(sdkDir, 'package.json'), 'utf8'));
  const native = require.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === 'win32' ? '.exe' : ''}`,
  );
  const auth = await execa(native, ['auth', 'status', '--json'], {
    reject: false,
    timeout: 10000,
    windowsHide: true,
    cwd: directory,
  });
  const status = JSON.parse(auth.stdout);
  result.claude = {
    sdkVersion: sdk.version,
    runtimeVersion: sdk.claudeCodeVersion,
    loggedIn: status.loggedIn,
    authMethod: status.authMethod,
    apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
    liveProbe: process.env.ANTHROPIC_API_KEY
      ? 'ready to attempt bounded API probe'
      : 'blocked: configure approved API authentication',
  };
} catch (error) {
  result.claude = { error: String(error), liveProbe: 'blocked' };
}
const client = new CopilotClient({ workingDirectory: directory });
try {
  await client.start();
  const auth = await client.getAuthStatus();
  const status = await client.getStatus();
  result.copilot = {
    runtimeVersion: status.version,
    protocolVersion: status.protocolVersion,
    authenticated: auth.isAuthenticated,
    liveProbe: auth.isAuthenticated
      ? 'ready to attempt bounded probe'
      : 'blocked: sign in or configure a Copilot-entitled token',
  };
} catch (error) {
  result.copilot = { error: String(error), liveProbe: 'blocked' };
} finally {
  await client.stop();
}
await mkdir('.artifacts', { recursive: true });
await writeFile('.artifacts/provider-auth-status.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
