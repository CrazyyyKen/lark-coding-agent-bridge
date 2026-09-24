import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setSecret } from '../../../src/config/keystore.js';
import {
  COPILOT_STUDIO_DEFAULTS,
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema.js';
import {
  agentKindFromString,
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store.js';
import { copilotSecretEnvNames, resolveCopilotSecret } from '../../../src/config/secret-resolver.js';

const account = { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'lark' as const } };
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-config-'));
  dirs.push(dir);
  return dir;
}

describe('copilot-studio profile config', () => {
  it('creates a read-only profile with safe defaults and no secrets', () => {
    const profile = createDefaultProfileConfig({ agentKind: 'copilot-studio', accounts: account });
    expect(profile.agentKind).toBe('copilot-studio');
    expect(profile.permissions).toMatchObject({ defaultAccess: 'read-only', maxAccess: 'read-only' });
    expect(profile.copilotStudio).toMatchObject({
      directLineBaseUrl: COPILOT_STUDIO_DEFAULTS.directLineBaseUrl,
      completionMarker: '[[turn-complete]]',
      mcp: { bindHost: '127.0.0.1', port: 47_821, path: '/mcp', authHeader: 'x-api-key', allowedOrigins: [] },
    });
    expect(profile.copilotStudio?.directLineSecret).toBeUndefined();
    expect(profile.copilotStudio?.mcp.authSecret).toBeUndefined();
    expect(profile.copilotStudio?.cli.allowedOperations).toBeUndefined();
  });

  it('clamps numbers, keeps valid secret refs and drops malformed ones', () => {
    const profile = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'copilot-studio',
      accounts: account,
      copilotStudio: {
        pollIntervalMs: 1,
        turnTimeoutMs: 999_999_999,
        directLineSecret: { source: 'keystore', id: 'copilot-studio.direct-line-secret' },
        mcp: { port: 99_999, path: 'no-leading-slash', authHeader: 'Bad Header!', authSecret: { source: 'nope', id: 'x' } },
        cli: { allowedOperations: ['whoami', 3] },
      },
    });
    const cs = profile.copilotStudio!;
    expect(cs.pollIntervalMs).toBe(250);
    expect(cs.turnTimeoutMs).toBe(30 * 60_000);
    expect(cs.directLineSecret).toEqual({ source: 'keystore', id: 'copilot-studio.direct-line-secret' });
    expect(cs.mcp.port).toBe(65_535);
    expect(cs.mcp.path).toBe('/mcp');
    expect(cs.mcp.authHeader).toBe('x-api-key');
    expect(cs.mcp.authSecret).toBeUndefined();
    expect(cs.cli.allowedOperations).toEqual(['whoami']);
  });

  it('round-trips through config.json without dropping the copilotStudio section', async () => {
    const dir = await tmp();
    const file = join(dir, 'config.json');
    const profile = createDefaultProfileConfig({ agentKind: 'copilot-studio', accounts: account });
    profile.copilotStudio!.directLineSecret = { source: 'keystore', id: 'copilot-studio.direct-line-secret' };
    profile.copilotStudio!.mcp.publicUrl = 'https://bridge.example.com';
    const root = createRootConfig('copilot', profile);
    root.profiles.claude = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { ...account.app, id: 'cli_other' } } });
    await saveRootConfig(root, file);
    const loaded = await loadRootConfig(file);
    expect(loaded?.profiles.copilot?.copilotStudio).toEqual(profile.copilotStudio);
    expect(loaded?.profiles.claude?.agentKind).toBe('claude');
    expect(loaded?.profiles.claude?.copilotStudio).toBeUndefined();
    expect(await readFile(file, 'utf8')).not.toMatch(/fake-direct-line-secret/);
  });

  it('names the offending profile for an unsupported agent kind', async () => {
    const dir = await tmp();
    const file = join(dir, 'config.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        activeProfile: 'ok',
        preferences: {},
        profiles: {
          ok: { schemaVersion: 2, agentKind: 'claude', accounts: account },
          legacy: { schemaVersion: 2, agentKind: 'copilot', accounts: account },
        },
      }),
    );
    await expect(loadRootConfig(file)).rejects.toThrow(/profile legacy: agentKind must be one of/);
  });

  it('parses --agent copilot-studio and rejects unknown kinds', () => {
    expect(agentKindFromString('copilot-studio')).toBe('copilot-studio');
    expect(() => agentKindFromString('copilot')).toThrow(/unsupported agent: copilot/);
  });
});

describe('copilot secret resolution', () => {
  it('refuses plaintext secrets in config.json', async () => {
    await expect(resolveCopilotSecret('plaintext-direct-line-secret', 'copilotStudio.directLineSecret', undefined)).rejects.toThrow(
      /plaintext value/,
    );
    await expect(resolveCopilotSecret(undefined, 'copilotStudio.directLineSecret', undefined)).rejects.toThrow(
      /not configured/,
    );
  });

  it('resolves env templates, env refs and keystore refs', async () => {
    const dir = await tmp();
    const keystore = { secretsFile: join(dir, 'secrets.enc'), keystoreSaltFile: join(dir, '.salt') };
    process.env.COPILOT_TEST_SECRET = 'from-env';
    try {
      await expect(resolveCopilotSecret('${COPILOT_TEST_SECRET}', 'x', undefined, keystore)).resolves.toBe('from-env');
      await expect(resolveCopilotSecret({ source: 'env', id: 'COPILOT_TEST_SECRET' }, 'x', undefined, keystore)).resolves.toBe(
        'from-env',
      );
    } finally {
      delete process.env.COPILOT_TEST_SECRET;
    }
    await setSecret('copilot-studio.direct-line-secret', 'from-keystore', keystore);
    await expect(
      resolveCopilotSecret({ source: 'keystore', id: 'copilot-studio.direct-line-secret' }, 'x', undefined, keystore),
    ).resolves.toBe('from-keystore');
    await expect(resolveCopilotSecret({ source: 'keystore', id: 'missing' }, 'label', undefined, keystore)).rejects.toThrow(
      /label: keystore has no entry/,
    );
  });

  it('reports env var names so child processes can drop them', () => {
    expect(copilotSecretEnvNames('${DL_SECRET}')).toEqual(['DL_SECRET']);
    expect(copilotSecretEnvNames({ source: 'env', id: 'MCP_KEY' })).toEqual(['MCP_KEY']);
    expect(copilotSecretEnvNames({ source: 'keystore', id: 'x' })).toEqual([]);
    expect(copilotSecretEnvNames(undefined)).toEqual([]);
  });
});
