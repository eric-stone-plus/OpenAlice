// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../i18n'
import { SessionModeSelect } from './SessionModeSelect'

afterEach(cleanup)

describe('SessionModeSelect', () => {
  it('opens the menu without throwing and exposes Auto/Goal', async () => {
    const user = userEvent.setup()
    render(<SessionModeSelect value="auto" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Session mode' })
    await user.click(trigger)
    expect(await screen.findByRole('menuitemradio', { name: /Auto/ })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /Goal/ })).toBeTruthy()
  })
})
