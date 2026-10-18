import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearShutdownMarker,
  readShutdownMarker,
  shutdownMarkerPath,
  writeShutdownMarker,
} from './shutdown-marker.js'

describe('desktop shutdown marker', () => {
  const homes: string[] = []
  const home = (): string => {
    const value = mkdtempSync(join(tmpdir(), 'openalice-shutdown-'))
    homes.push(value)
    return value
  }

  afterEach(() => {
    for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true })
  })

  it('round-trips the quitting pid under the data home', () => {
    const value = home()
    writeShutdownMarker(value, 4242, new Date('2026-10-18T00:00:00.000Z'))

    expect(shutdownMarkerPath(value)).toBe(join(value, 'state', 'desktop-shutdown.json'))
    expect(readShutdownMarker(value)).toEqual({
      pid: 4242,
      startedAt: '2026-10-18T00:00:00.000Z',
    })
  })

  it('treats missing and malformed markers as absent', () => {
    const value = home()
    expect(readShutdownMarker(value)).toBeNull()

    writeShutdownMarker(value, 4242)
    writeFileSync(shutdownMarkerPath(value), 'not json', 'utf8')
    expect(readShutdownMarker(value)).toBeNull()
  })

  it('clears the marker after the owner releases its locks', () => {
    const value = home()
    writeShutdownMarker(value, 4242)
    clearShutdownMarker(value)

    expect(readShutdownMarker(value)).toBeNull()
  })
})
