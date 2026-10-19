// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../i18n'
import { AIProviderPage } from './AIProviderPage'

beforeEach(async () => {
  await i18n.changeLanguage('zh')
})

afterEach(cleanup)

describe('AIProviderPage', () => {
  it('shows only the native opencode DeepSeek provider', () => {
    render(<AIProviderPage />)

    expect(screen.getByRole('heading', { name: 'AI 提供方' })).toBeTruthy()
    expect(screen.getByText('通过 opencode 使用 DeepSeek')).toBeTruthy()
    expect(screen.getByText('deepseek/deepseek-flash')).toBeTruthy()
    expect(screen.getByText('推理强度')).toBeTruthy()
    expect(screen.getByText('max')).toBeTruthy()
    expect(screen.getByText('本地 opencode 配置与认证存储')).toBeTruthy()
  })

  it('does not offer a credential vault or other provider routes', () => {
    render(<AIProviderPage />)

    expect(screen.queryByRole('button', { name: /添加|编辑|删除/ })).toBeNull()
    expect(screen.queryByText(/Gemini|OpenAI|Anthropic|OpenRouter/i)).toBeNull()
  })

  it('renders the native provider in English', async () => {
    await i18n.changeLanguage('en')
    render(<AIProviderPage />)

    expect(screen.getByText('DeepSeek via opencode')).toBeTruthy()
    expect(screen.getByText('deepseek/deepseek-flash')).toBeTruthy()
    expect(screen.getByText('max')).toBeTruthy()
    expect(screen.getByText('Local opencode config and auth store')).toBeTruthy()
  })
})
