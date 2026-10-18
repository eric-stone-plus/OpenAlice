import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installConsoleEpipeGuard, type ConsoleSink } from './console-guard.js'

function codedError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

function silentSink(): ConsoleSink {
  return { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

describe('installConsoleEpipeGuard', () => {
  it('swallows EPIPE thrown by a console write and keeps other failures loud', () => {
    const sink = silentSink()
    sink.log = () => { throw codedError('EPIPE') }
    installConsoleEpipeGuard([], sink)
    expect(() => sink.log('closed terminal')).not.toThrow()

    sink.error = () => { throw codedError('EIO', 'disk gone') }
    expect(() => sink.error('still fatal')).toThrow('disk gone')
  })

  it('swallows EPIPE stream errors only', () => {
    const stream = new EventEmitter()
    installConsoleEpipeGuard([stream], silentSink())
    expect(() => stream.emit('error', codedError('EPIPE'))).not.toThrow()
    expect(() => stream.emit('error', codedError('EIO', 'broken'))).toThrow('broken')
  })

  it('restores the console methods and stream listeners when uninstalled', () => {
    const stream = new EventEmitter()
    const sink = silentSink()
    const original = sink.log
    const uninstall = installConsoleEpipeGuard([stream], sink)
    expect(sink.log).not.toBe(original)
    uninstall()
    expect(sink.log).toBe(original)
    expect(stream.listenerCount('error')).toBe(0)
  })
})
