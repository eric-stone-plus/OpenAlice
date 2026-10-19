import { describe, expect, it } from 'vitest';

import type { ResolvedSessionRuntimeBinding } from '../cli-adapter.js';
import { opencodeAdapter } from './opencode.js';
import { OPENCODE_TRADE_AGENT } from './opencode-trade-agent.js';

const nativeRuntime: ResolvedSessionRuntimeBinding = {
  binding: {
    version: 1,
    credential: { source: 'native' },
  },
  ai: null,
};

/** A legacy vault/workspace binding that must be ignored by the native path. */
const staleVaultRuntime: ResolvedSessionRuntimeBinding = {
  binding: {
    version: 1,
    credential: { source: 'vault', credentialSlug: 'openrouter-1' },
    model: 'deepseek/deepseek-v4.1-flash',
    reasoningEffort: 'high',
  },
  ai: {
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    reasoningEffort: 'high',
    wireShape: 'openai-chat',
  },
};

describe('opencode runtime flags', () => {
  it('pins the app-owned Trade profile to deepseek-flash at max effort', () => {
    // opencode resolves an agent variant only when the agent names a model;
    // the pair is what makes `variant: max` reach the provider.
    expect(OPENCODE_TRADE_AGENT.model).toBe('deepseek/deepseek-flash');
    expect(OPENCODE_TRADE_AGENT.variant).toBe('max');
  });

  it('always projects the native DeepSeek Trade profile, ignoring stale bindings', () => {
    for (const runtime of [nativeRuntime, staleVaultRuntime]) {
      const projected = opencodeAdapter.sessionRuntime!.project(
        { cwd: '/workspace', env: {} },
        runtime,
      );

      expect(projected.interactiveArgs).toEqual(['--model', 'deepseek/deepseek-flash']);
      expect(projected.headlessArgs).toEqual([
        '--model', 'deepseek/deepseek-flash',
        '--variant', 'max',
        '--agent', 'trade',
      ]);
      expect(projected.webArgs).toEqual([]);
      expect(projected.webConfigPin).toEqual({
        model: 'deepseek/deepseek-flash',
        reasoningEffort: 'max',
        mode: 'trade',
      });
      const config = JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!);
      expect(config).toEqual({
        default_agent: 'trade',
        agent: { trade: OPENCODE_TRADE_AGENT },
        model: 'deepseek/deepseek-flash',
      });
      expect(config.provider).toBeUndefined();
      expect(JSON.stringify(config)).not.toContain('test-key');
      expect(JSON.stringify(config)).not.toContain('openrouter.ai');
    }
  });

  it('does not carry a vault key into the process environment', () => {
    const processEnv = { OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' };
    const projected = opencodeAdapter.sessionRuntime!.project(
      { cwd: '/workspace', env: processEnv },
      staleVaultRuntime,
    );
    expect(processEnv).toEqual({ OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' });
    expect(JSON.stringify(projected.env)).not.toContain('test-key');
    expect(projected.env['OPENCODE_CONFIG_CONTENT']).toBe(
      '{"default_agent":"trade","agent":{"trade":' + JSON.stringify(OPENCODE_TRADE_AGENT) + '},"model":"deepseek/deepseek-flash"}',
    );
  });

  it('keeps run-only --variant off the interactive and web launch surfaces', () => {
    const projected = opencodeAdapter.sessionRuntime!.project(
      { cwd: '/workspace', env: {} },
      nativeRuntime,
    );

    expect(projected.interactiveArgs).toEqual(['--model', 'deepseek/deepseek-flash']);
    expect(projected.webArgs).toEqual([]);

    expect(opencodeAdapter.composeCommand([], {
      cwd: '/workspace',
      env: {},
      resume: 'last',
      sessionRuntime: projected,
    })).toEqual(['opencode', '--model', 'deepseek/deepseek-flash', '--continue']);

    expect(opencodeAdapter.composeHeadlessCommand!([], {
      cwd: '/workspace',
      env: {},
      sessionRuntime: projected,
    }, 'hello')).toContain('--variant');
    expect(opencodeAdapter.composeHeadlessCommand!([], {
      cwd: '/workspace',
      env: {},
      sessionRuntime: projected,
    }, 'hello')).toContain('--agent');
  });
});

it('projects the app overlay without rewriting the process config', () => {
  const processEnv = { OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' };
  const projected = opencodeAdapter.sessionRuntime!.project({ cwd: '/workspace', env: processEnv }, nativeRuntime);
  expect(processEnv).toEqual({ OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' });
  expect(JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({
    default_agent: 'trade',
    agent: { trade: OPENCODE_TRADE_AGENT },
    model: 'deepseek/deepseek-flash',
  });
  expect(opencodeAdapter.composeWebCommand!([], { cwd: '/workspace', env: projected.env, sessionRuntime: projected })).toEqual(['opencode', 'acp']);
});

it('does not inject a top-level permission override', () => {
  const projected = opencodeAdapter.sessionRuntime!.project(
    { cwd: '/workspace', env: { OPENCODE_CONFIG_CONTENT: '{"theme":"system","permission":"ask"}' } },
    { binding: { version: 1, credential: { source: 'native' } }, ai: null },
  );
  // The overlay adds the Trade profile and its locked model; permissions stay
  // scoped to that agent.
  const config = JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!);
  expect(config).toEqual({
    default_agent: 'trade',
    agent: { trade: OPENCODE_TRADE_AGENT },
    model: 'deepseek/deepseek-flash',
  });
  expect(config.permission).toBeUndefined();
});

it('disables the legacy Workspace provider file writer', async () => {
  await expect(opencodeAdapter.writeAiConfig!('/workspace', { apiKey: 'test-key' }))
    .rejects.toThrow('native-only');
  await expect(opencodeAdapter.readAiConfig!('/workspace')).resolves.toBeNull();
});

it('matches the terminal wrapper environment and leaves auto-update enabled', () => {
  const env = opencodeAdapter.composeEnv!({ cwd: '/workspace', env: {} });
  expect(env).toEqual({
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  });
  expect(env['OPENCODE_DISABLE_AUTOUPDATE']).toBeUndefined();
});
