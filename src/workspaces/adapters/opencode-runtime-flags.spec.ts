import { describe, expect, it } from 'vitest';

import type { ResolvedSessionRuntimeBinding } from '../cli-adapter.js';
import { opencodeAdapter } from './opencode.js';
import { OPENCODE_TRADE_AGENT } from './opencode-trade-agent.js';

const runtime: ResolvedSessionRuntimeBinding = {
  binding: {
    version: 1,
    credential: { source: 'native' },
    model: 'openai/gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  ai: {
    model: 'openai/gpt-5.6-sol',
    reasoningEffort: 'high',
  },
};

describe('opencode runtime flags', () => {
  it('pins the app-owned Trade profile to deepseek-flash at max effort', () => {
    // opencode resolves an agent variant only when the agent names a model;
    // the pair is what makes `variant: max` reach the provider.
    expect(OPENCODE_TRADE_AGENT.model).toBe('deepseek/deepseek-flash');
    expect(OPENCODE_TRADE_AGENT.variant).toBe('max');
  });

  it('locks the native DeepSeek path to the stable alias and max effort', () => {
    const projected = opencodeAdapter.sessionRuntime!.project(
      { cwd: '/workspace', env: {} },
      {
        binding: {
          version: 1,
          credential: { source: 'native' },
          // A stale session binding must not pin a dated model or lower effort.
          model: 'deepseek/deepseek-v4.1-flash',
          reasoningEffort: 'high',
        },
        ai: null,
      },
    );

    expect(projected.interactiveArgs).toEqual(['--model', 'deepseek/deepseek-flash']);
    expect(projected.headlessArgs).toEqual([
      '--model', 'deepseek/deepseek-flash',
      '--variant', 'max',
      '--agent', 'trade',
    ]);
    expect(JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({
      default_agent: 'trade',
      agent: { trade: OPENCODE_TRADE_AGENT },
      model: 'deepseek/deepseek-flash',
    });
  });

  it('locks a workspace DeepSeek provider to the stable alias and max effort', () => {
    const projected = opencodeAdapter.sessionRuntime!.project(
      { cwd: '/workspace', env: {} },
      {
        binding: {
          version: 1,
          credential: { source: 'vault', credentialSlug: 'deepseek-1' },
          model: 'deepseek-v4-pro',
          reasoningEffort: 'high',
        },
        ai: {
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'high',
          wireShape: 'openai-chat',
        },
      },
    );

    expect(projected.interactiveArgs).toEqual(['--model', 'openalice-session/deepseek-flash']);
    expect(projected.headlessArgs).toEqual([
      '--model', 'openalice-session/deepseek-flash',
      '--variant', 'max',
      '--agent', 'trade',
    ]);
    const config = JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!);
    expect(config.agent.trade).toMatchObject({
      model: 'openalice-session/deepseek-flash',
      variant: 'max',
    });
    expect(config.model).toBe('openalice-session/deepseek-flash');
    expect(config.provider['openalice-session'].models['deepseek-flash']).toMatchObject({
      options: { reasoningEffort: 'max' },
      limit: { context: 1_000_000 },
    });
  });

  it('keeps a non-DeepSeek workspace endpoint on its own model and effort', () => {
    // A DeepSeek model id behind a different endpoint (for example OpenRouter)
    // must not be rewritten to the DeepSeek preset's `deepseek-flash` alias.
    const projected = opencodeAdapter.sessionRuntime!.project(
      { cwd: '/workspace', env: {} },
      {
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
      },
    );

    expect(projected.interactiveArgs).toEqual([
      '--model', 'openalice-session/deepseek/deepseek-v4.1-flash',
    ]);
    expect(projected.headlessArgs).toEqual([
      '--model', 'openalice-session/deepseek/deepseek-v4.1-flash',
      '--variant', 'high',
      '--agent', 'trade',
    ]);
    const config = JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!);
    expect(config.model).toBe('openalice-session/deepseek/deepseek-v4.1-flash');
    expect(config.provider['openalice-session'].models['deepseek/deepseek-v4.1-flash'])
      .toMatchObject({ options: { reasoningEffort: 'high' } });
  });

  it('keeps run-only --variant off the interactive and web launch surfaces', () => {
    const projected = opencodeAdapter.sessionRuntime!.project(
      { cwd: '/workspace', env: {} },
      runtime,
    );

    expect(projected.interactiveArgs).toEqual(['--model', 'openai/gpt-5.6-sol']);
    expect(projected.webArgs).toEqual([]);
    expect(JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({
      default_agent: 'trade',
      agent: { trade: OPENCODE_TRADE_AGENT },
      model: 'openai/gpt-5.6-sol',
    });
    expect(projected.headlessArgs).toEqual([
      '--model', 'openai/gpt-5.6-sol',
      '--variant', 'high',
      '--agent', 'trade',
    ]);

    expect(opencodeAdapter.composeCommand([], {
      cwd: '/workspace',
      env: {},
      resume: 'last',
      sessionRuntime: projected,
    })).toEqual(['opencode', '--model', 'openai/gpt-5.6-sol', '--continue']);

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
  const projected = opencodeAdapter.sessionRuntime!.project({ cwd: '/workspace', env: processEnv }, runtime);
  expect(processEnv).toEqual({ OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' });
  expect(JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({
    default_agent: 'trade',
    agent: { trade: OPENCODE_TRADE_AGENT },
    model: 'openai/gpt-5.6-sol',
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

it('matches the terminal wrapper environment and leaves auto-update enabled', () => {
  const env = opencodeAdapter.composeEnv!({ cwd: '/workspace', env: {} });
  expect(env).toEqual({
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  });
  expect(env['OPENCODE_DISABLE_AUTOUPDATE']).toBeUndefined();
});
