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

it('does not inject a top-level permission override without a model override', () => {
  const projected = opencodeAdapter.sessionRuntime!.project(
    { cwd: '/workspace', env: { OPENCODE_CONFIG_CONTENT: '{"theme":"system","permission":"ask"}' } },
    { binding: { version: 1, credential: { source: 'native' } }, ai: null },
  );
  // The overlay adds the Trade profile; permissions stay scoped to that agent.
  const config = JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!);
  expect(config).toEqual({
    default_agent: 'trade',
    agent: { trade: OPENCODE_TRADE_AGENT },
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
