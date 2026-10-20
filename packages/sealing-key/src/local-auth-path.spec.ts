import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

import {
  LOCAL_TOKEN_PATTERN,
  LOCAL_TOKEN_RELATIVE_PATH,
  localTokenPath,
} from './index.js'

describe('local auth token path', () => {
  it('keeps the token under the home auth directory', () => {
    expect(LOCAL_TOKEN_RELATIVE_PATH).toBe(join('auth', 'local.token'))
    expect(localTokenPath('/home/alice')).toBe(join('/home/alice', 'auth', 'local.token'))
  })

  it('shares the token format with every reader', () => {
    expect(LOCAL_TOKEN_PATTERN.test(`oa1_${'A'.repeat(43)}`)).toBe(true)
    expect(LOCAL_TOKEN_PATTERN.test(`oa1_${'A'.repeat(42)}`)).toBe(false)
  })
})
