// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../i18n'
import { AIProviderPage } from './AIProviderPage'

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AIProviderPage native status', () => {
  it('renders without reading the removed credential vault', () => {
    const fetch = vi.fn(() => Promise.reject(new Error('vault endpoint removed')))
    vi.stubGlobal('fetch', fetch)
    render(<AIProviderPage />)

    expect(screen.getByText('DeepSeek via opencode')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
