// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../i18n'
import { SessionModeSelect } from './SessionModeSelect'

afterEach(cleanup)

describe('SessionModeSelect', () => {
  it('opens the menu without throwing and exposes only Trade', async () => {
    const user = userEvent.setup()
    render(<SessionModeSelect value="trade" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Session mode' })
    await user.click(trigger)
    expect(await screen.findByRole('menuitemradio', { name: /Trade/ })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /Auto/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: /Goal/ })).toBeNull()
  })
})
