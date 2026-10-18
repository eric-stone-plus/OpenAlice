import { describe, expect, it } from 'vitest';

import type { ResolvedSessionRuntimeBinding } from '../cli-adapter.js';
import { opencodeAdapter } from './opencode.js';

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
  it('keeps run-only --variant off the interactive and web launch surfaces', () => {
    const projected = opencodeAdapter.sessionRuntime!.project(
      { cwd: '/workspace', env: {} },
      runtime,
    );

    expect(projected.interactiveArgs).toEqual(['--model', 'openai/gpt-5.6-sol']);
    expect(projected.webArgs).toEqual([]);
    expect(JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({ model: 'openai/gpt-5.6-sol' });
    expect(projected.headlessArgs).toEqual([
      '--model', 'openai/gpt-5.6-sol',
      '--variant', 'high',
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
  });
});

it('preserves process config while selecting the ACP model without unsupported flags', () => {
  const projected = opencodeAdapter.sessionRuntime!.project({ cwd: '/workspace', env: { OPENCODE_CONFIG_CONTENT: '{"theme":"system"}' } }, runtime);
  expect(JSON.parse(projected.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({ theme: 'system', model: 'openai/gpt-5.6-sol' });
  expect(opencodeAdapter.composeWebCommand!([], { cwd: '/workspace', env: projected.env, sessionRuntime: projected })).toEqual(['opencode', 'acp']);
});

it('does not inject a permission override without a model override', () => {
  const projected = opencodeAdapter.sessionRuntime!.project(
    { cwd: '/workspace', env: { OPENCODE_CONFIG_CONTENT: '{"theme":"system","permission":"ask"}' } },
    { binding: { version: 1, credential: { source: 'native' } }, ai: null },
  );
  // No app-specific config is projected; the process/terminal config survives
  // unchanged through the inherited spawn environment.
  expect(projected.env['OPENCODE_CONFIG_CONTENT']).toBeUndefined();
});

it('matches the terminal wrapper environment and leaves auto-update enabled', () => {
  const env = opencodeAdapter.composeEnv!({ cwd: '/workspace', env: {} });
  expect(env).toEqual({
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  });
  expect(env['OPENCODE_DISABLE_AUTOUPDATE']).toBeUndefined();
});
