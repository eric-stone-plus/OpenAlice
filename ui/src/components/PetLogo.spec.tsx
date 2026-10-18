// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import aliceLogo from '../assets/alice-logo.png'
import { i18n } from '../i18n'
import { PetLogo } from './PetLogo'

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('welcome-screen Alice logo', () => {
  it('renders the artwork as the interactive mark', () => {
    render(<PetLogo />)

    const button = screen.getByRole('button', { name: i18n.t('pet.speakQuote') })
    const image = button.querySelector('img')
    expect(image?.getAttribute('src')).toBe(aliceLogo)
    expect(image?.getAttribute('alt')).toBe('')
    expect(button.className).toContain('size-[180px]')
    expect(button.className).toContain('@min-[42rem]/harness:size-[220px]')
    expect(button.className).not.toMatch(/(^|\s)(bg|shadow)-/)
    expect(button.className).toContain('focus-visible:ring-ring')
  })

  it('cycles Alice quotes on click and hides them again', () => {
    vi.useFakeTimers()
    render(<PetLogo />)

    const button = screen.getByRole('button', { name: i18n.t('pet.speakQuote') })
    expect(screen.getByRole('status').textContent).toBe('')
    fireEvent.click(button)
    expect(screen.getByRole('status').textContent).toContain('Curiouser and curiouser!')

    fireEvent.click(button)
    expect(screen.getByRole('status').textContent).toContain('What a curious feeling!')

    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('speaks from the keyboard', async () => {
    const user = userEvent.setup()
    render(<PetLogo />)

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: i18n.t('pet.speakQuote') }))
    await user.keyboard('{Enter}')
    expect(screen.getByRole('status').textContent).toContain('Curiouser and curiouser!')
  })
})
