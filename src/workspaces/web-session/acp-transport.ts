/**
 * Agent Client Protocol (https://agentclientprotocol.com) over stdio.
 *
 * Cursor Agent (`agent acp`), Grok Build (`grok agent stdio`) and opencode
 * (`opencode acp`) implement the agent side natively. Alice is the client: it
 * advertises no filesystem or terminal capabilities, so agents keep using
 * their own tools, and only permission requests round-trip to the browser.
 */
import { JsonRpcPeer, type JsonRpcError } from './json-rpc.js'
import {
  isJsonObject,
  stringOrNull,
  type JsonObject,
  type WebContentPart,
  type WebPermissionRequest,
  type WebRequestOption,
  type WebRequestOptionTone,
  type WebSessionConfigOption,
} from './model.js'
import { TranscriptBuilder } from './transcript-builder.js'
import type { WebSessionTransport, WebTransportContext } from './transport.js'

const ACP_PROTOCOL_VERSION = 1
const SESSION_LOAD_TIMEOUT_MS = 120_000
const MODEL_OPTION_IDS = ['model'] as const
const EFFORT_OPTION_IDS = ['effort', 'reasoningEffort', 'reasoning_effort', 'variant'] as const
const MODE_OPTION_IDS = ['mode'] as const

type PinKind = 'model' | 'effort' | 'mode'
type ConfigPin = NonNullable<WebTransportContext['input']['configPin']>

/** One matcher table for discovery and for the post-change pin guard, so the
 *  two paths cannot drift when a runtime renames an option id. */
const PINNED_OPTION_MATCHERS: Record<PinKind, {
  readonly ids: readonly string[]
  readonly categories: readonly string[]
  readonly value: (pin: ConfigPin) => string | undefined
}> = {
  model: { ids: MODEL_OPTION_IDS, categories: ['model'], value: pin => pin.model },
  effort: { ids: EFFORT_OPTION_IDS, categories: ['thought_level', 'effort'], value: pin => pin.reasoningEffort },
  mode: { ids: MODE_OPTION_IDS, categories: ['mode'], value: pin => pin.mode },
}
const PIN_KINDS: readonly PinKind[] = ['model', 'effort', 'mode']
/** A runtime that ignores session/cancel must not block every later prompt. */
export const ACP_CANCEL_WATCHDOG_MS = 10_000
/** A released turn that never settles must not leave the session fenced. */
export const ACP_RELEASED_PROMPT_FENCE_MS = 30_000

interface PendingPermission {
  readonly rpcId: string | number
  readonly resolve: (outcome: JsonObject) => void
}

export class AcpTransport implements WebSessionTransport {
  private readonly peer: JsonRpcPeer
  private readonly builder: TranscriptBuilder
  private readonly permissions = new Map<string, PendingPermission>()
  private sessionId: string | null
  private pendingUserText: string | null = null
  private turnActive = false
  private cancelRequested = false
  private cancelWatchdog: NodeJS.Timeout | null = null
  private turnGeneration = 0
  /** A session/prompt request is outstanding (the watchdog only applies then). */
  private promptOutstanding = false
  /** Turns the watchdog released while their prompts are still outstanding.
   *  Their content is fenced until each request settles or its deadline hits. */
  private readonly releasedPrompts = new Map<number, NodeJS.Timeout>()
  private disposed = false
  private pinRestoreRunning: Promise<void> | null = null
  private pinRestorePending = false
  private readonly advertisedPinOptions = new Set<PinKind>()

  constructor(private readonly ctx: WebTransportContext) {
    this.sessionId = ctx.input.nativeSessionId ?? null
    this.builder = new TranscriptBuilder(ctx.state)
    this.peer = new JsonRpcPeer(ctx.channel, ctx.logger, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
    })
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('ACP session is not established')
    const init = await this.peer.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'openalice', title: 'OpenAlice', version: '1' },
    })
    const capabilities = isJsonObject(init) && isJsonObject(init['agentCapabilities']) ? init['agentCapabilities'] : {}
    const canLoad = capabilities['loadSession'] === true
    const params = { cwd: this.ctx.input.cwd, mcpServers: [] }
    try {
      if (this.sessionId && canLoad) {
        const loaded = await this.peer.request('session/load', { sessionId: this.sessionId, ...params }, SESSION_LOAD_TIMEOUT_MS)
        this.applyConfigOptions(loaded)
        this.flushUser()
        this.builder.endTurn()
      } else {
        if (this.sessionId) {
          throw new Error(`${this.ctx.input.agent} cannot reopen this conversation over ACP. Open the existing Session in the terminal, or create a separate new Session.`)
        }
        const created = await this.peer.request('session/new', params)
        const id = isJsonObject(created) ? stringOrNull(created['sessionId']) : null
        if (!id) throw new Error('ACP session/new returned no sessionId')
        this.sessionId = id
        this.applyConfigOptions(created)
      }
    } catch (error) {
      throw describeAcpFailure(error, this.ctx.input.agent)
    }
    this.ctx.state.setNativeSessionId(this.sessionId)
    // Only apply the OpenAlice mode when the runtime actually advertises it.
    // The app passes a mode only for opencode, whose overlay always adds the
    // Trade profile; a missing mode means the app-owned pin failed, so fail
    // loudly instead of silently running the terminal's auto/goal default.
    const requestedMode = this.ctx.input.agentMode
    const modeOption = this.findPinnedOption('mode')
    const modeOffered = requestedMode
      ? modeOption?.options.some((entry) => entry.value === requestedMode) === true
      : false
    if (requestedMode && !modeOffered) {
      throw new Error(`${this.ctx.input.agent} did not offer the requested ${requestedMode} session mode`)
    }
    if (requestedMode && modeOption) await this.configure(modeOption.id, requestedMode)
    await this.applyConfigPin()
    this.ctx.state.setPhase('idle')
  }

  async prompt(message: string): Promise<void> {
    if (this.disposed) throw new Error('ACP session is not established')
    const text = message.trim()
    if (!text) throw new Error('prompt cannot be empty')
    if (!this.sessionId) throw new Error('ACP session is not established')
    if (this.turnActive) throw new Error(`${this.ctx.input.agent} is still working on the previous prompt`)
    // A released turn is still running in the runtime and ACP updates carry no
    // turn id; a replacement prompt could only be corrupted by its frames.
    // The fence settles or fails the session within ACP_RELEASED_PROMPT_FENCE_MS.
    if (this.releasedPrompts.size > 0) throw new Error(`${this.ctx.input.agent} is still settling the previous turn`)
    // Claim the turn before the first await: a second prompt can arrive while
    // the pin restore is in flight and must not pass the same check.
    this.turnActive = true
    this.cancelRequested = false
    const turnGeneration = ++this.turnGeneration
    // The app-owned model/effort/mode invariant must hold before every turn,
    // not only after session/new or a configure() call. A runtime-initiated
    // drift that could not be restored fails the prompt instead of running.
    try {
      await this.ensureConfigPin()
    } catch (error) {
      // A watchdog release or dispose can change the generation while the pin
      // wait is in flight; a stale failure must not clear a newer turn.
      if (turnGeneration === this.turnGeneration) {
        this.turnActive = false
        this.cancelRequested = false
        this.clearCancelWatchdog()
        if (!this.ctx.channel.closed) this.ctx.state.fail(error instanceof Error ? error.message : String(error))
      }
      throw error
    }
    // A notification-triggered restore, cancel, or dispose can land while the
    // pin check awaits the runtime. Do not send a prompt into a cancelled or
    // closed turn. The generation check also catches a watchdog release: a new
    // prompt may have claimed the turn while this one was still waiting, and
    // this stale call must not send or clear the newer turn.
    if (turnGeneration !== this.turnGeneration) {
      throw new Error('the ACP turn was cancelled before the prompt was sent')
    }
    if (!this.turnActive || this.cancelRequested || this.ctx.channel.closed || !this.sessionId) {
      this.turnActive = false
      this.cancelRequested = false
      this.clearCancelWatchdog()
      throw new Error('the ACP turn was cancelled before the prompt was sent')
    }
    this.ctx.state.error = null
    this.builder.user(text)
    this.ctx.state.setPhase('working')
    this.promptOutstanding = true
    const turn = this.peer.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, null)
    void turn.then(
      (result) => this.finishTurn(isJsonObject(result) ? stringOrNull(result['stopReason']) : null, null, turnGeneration),
      (error: Error) => this.finishTurn(null, error, turnGeneration),
    )
  }

  async abort(): Promise<void> {
    if (this.disposed || !this.sessionId || !this.turnActive) return
    // Keep turnActive as the single-turn guard; a dedicated flag lets a cancel
    // that lands during the pin restore suppress the prompt without allowing a
    // second prompt to start while the cancelled turn is still settling.
    this.cancelRequested = true
    if (this.promptOutstanding) {
      this.armCancelWatchdog()
    } else {
      // No session/prompt was sent, so there is nothing for the runtime to
      // acknowledge. Release the claimed turn now; the post-pin generation
      // guard suppresses the stale prompt when the pin restore settles.
      this.releaseTurn(this.turnGeneration, new Error('cancelled before the prompt was sent'))
    }
    await this.peer.notify('session/cancel', { sessionId: this.sessionId })
  }

  /** Release a turn whose runtime ignored session/cancel. The generation check
   *  makes a late settlement harmless; the fence blocks a replacement prompt
   *  until that settlement or the fence deadline. */
  private armCancelWatchdog(): void {
    if (!this.turnActive || !this.promptOutstanding) return
    // A repeated abort must not push the deadline back indefinitely.
    if (this.cancelWatchdog) return
    const generation = this.turnGeneration
    this.cancelWatchdog = setTimeout(() => {
      this.cancelWatchdog = null
      if (!this.turnActive || !this.cancelRequested || !this.promptOutstanding
        || generation !== this.turnGeneration) return
      const message = `${this.ctx.input.agent} did not acknowledge session/cancel; releasing the turn`
      this.ctx.logger.warn(message)
      // finishTurn leaves the phase idle with the error set, so the composer
      // stays usable; `failed` is reserved for a dead process.
      try {
        this.releaseTurn(generation, new Error(message))
      } catch (error) {
        // A throwing host state listener must not crash the timer; releaseTurn
        // has already fenced the zombie prompt, and the fence deadline will
        // fail the session if it never settles.
        this.ctx.logger.warn('web_session.cancel_watchdog_failed', { error })
      }
    }, ACP_CANCEL_WATCHDOG_MS)
    this.cancelWatchdog.unref?.()
  }

  /** Release a turn whose prompt is still outstanding and fence its frames. */
  private releaseTurn(generation: number, error: Error): void {
    // Only a turn that already sent session/prompt can leave a zombie prompt.
    // A pin failure during the pre-prompt wait has nothing to settle, so
    // fencing it would fail a healthy session after the timeout.
    const promptSent = this.promptOutstanding && generation === this.turnGeneration
    try {
      this.finishTurn(null, error, generation)
    } finally {
      // finishTurn notifies host state listeners synchronously; if one throws,
      // the zombie prompt must still be fenced before the error propagates.
      if (promptSent) this.fenceReleasedPrompt(generation)
    }
  }

  private fenceReleasedPrompt(generation: number): void {
    const timer = setTimeout(() => {
      this.releasedPrompts.delete(generation)
      const message = `${this.ctx.input.agent} did not settle the cancelled turn; restart the session`
      this.ctx.logger.warn(message)
      try {
        if (!this.ctx.channel.closed) this.ctx.state.fail(message)
        // The transport cannot close the host's child process; ask the host to
        // stop the session so a plain reopen creates a fresh one. Host code may
        // throw; the transport must still dispose.
        this.ctx.onFatal(message)
      } catch (error) {
        // This runs in a timer callback; a throwing host hook must not crash
        // the server. Dispose below regardless.
        this.ctx.logger.warn('web_session.fatal_callback_failed', { error })
      } finally {
        this.dispose()
      }
    }, ACP_RELEASED_PROMPT_FENCE_MS)
    timer.unref?.()
    this.releasedPrompts.set(generation, timer)
  }

  private clearCancelWatchdog(): void {
    if (!this.cancelWatchdog) return
    clearTimeout(this.cancelWatchdog)
    this.cancelWatchdog = null
  }

  async configure(configId: string, value: string): Promise<void> {
    if (this.disposed) throw new Error('ACP session is not established')
    if (!this.sessionId) throw new Error('ACP session is not established')
    const option = this.ctx.state.configOptions.find((entry) => entry.id === configId)
    if (!option) throw new Error(`config option ${configId} is not offered by ${this.ctx.input.agent}`)
    if (!option.options.some((entry) => entry.value === value)) {
      throw new Error(`value ${value} is not offered for config option ${configId}`)
    }
    const pinned = this.pinnedValueFor(option)
    if (pinned !== undefined && value !== pinned) {
      throw new Error(`${configId} is pinned to ${pinned} by OpenAlice; ${value} is not allowed`)
    }
    const result = await this.peer.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId,
      value,
    })
    this.applyConfigOptions(result)
    if (this.ctx.input.configPin) {
      const mode = this.findPinnedOption('mode')
      if (mode && configId === mode.id) await this.applyConfigPin(true)
    }
  }

  async respond(requestId: string, optionId: string): Promise<void> {
    if (this.disposed) throw new Error('ACP session stopped')
    if (this.cancelRequested) throw new Error('the turn is cancelling; wait for it to settle')
    const request = this.ctx.state.requests.find((r) => r.id === requestId)
    const pending = this.permissions.get(requestId)
    if (!request || !pending) throw new Error(`no pending request ${requestId}`)
    if (!request.options.some((option) => option.id === optionId)) {
      throw new Error(`option ${optionId} is not offered by request ${requestId}`)
    }
    // Resolve the user's answer first: a runtime that is blocked on this
    // permission must not also wait for a config round-trip. The pin is
    // re-asserted immediately afterwards; failure aborts the turn.
    if (this.permissions.get(requestId) !== pending) return
    this.permissions.delete(requestId)
    this.ctx.state.removeRequest(requestId)
    pending.resolve({ outcome: { outcome: 'selected', optionId } })
    // Capture the turn before the pin round-trip: the runtime is already
    // unblocked and may finish the turn while the restore is in flight.
    const generation = this.turnGeneration
    if (this.ctx.channel.closed) return
    try {
      await this.ensureConfigPin()
    } catch (error) {
      const message = `could not restore the pinned ${this.ctx.input.agent} config: ${error instanceof Error ? error.message : String(error)}`
      this.ctx.logger.warn(message)
      if (this.turnActive && generation === this.turnGeneration && !this.ctx.channel.closed) {
        void this.abort().catch(() => undefined)
        this.releaseTurn(generation, new Error(message))
        this.ctx.state.fail(message)
      }
      throw error
    }
    // The turn may have completed or the channel may have closed during the
    // pin round-trip; do not report a successful answer for a dead session.
    if (this.ctx.channel.closed || generation !== this.turnGeneration) return
  }

  dispose(): void {
    // Invalidate any in-flight prompt settlement before disposing.
    this.disposed = true
    this.turnGeneration += 1
    this.turnActive = false
    this.cancelRequested = false
    this.promptOutstanding = false
    for (const timer of this.releasedPrompts.values()) clearTimeout(timer)
    this.releasedPrompts.clear()
    this.clearCancelWatchdog()
    this.cancelPermissions()
    this.peer.dispose(new Error('ACP session stopped'))
  }

  private finishTurn(stopReason: string | null, error: Error | null, generation: number): void {
    // The released turn's eventual settlement ends its fence, but it must not
    // touch the turn that replaced it.
    const fenceTimer = this.releasedPrompts.get(generation)
    if (fenceTimer) {
      clearTimeout(fenceTimer)
      this.releasedPrompts.delete(generation)
    }
    // A cancelled prompt can settle after the turn was already finalized and
    // a new prompt started. Ignore that stale settlement.
    if (generation !== this.turnGeneration) return
    this.clearCancelWatchdog()
    this.promptOutstanding = false
    this.turnGeneration += 1
    this.turnActive = false
    this.cancelRequested = false
    this.cancelPermissions()
    this.flushUser()
    this.builder.endTurn()
    if (error) {
      if (!this.ctx.channel.closed) {
        this.ctx.state.error = error.message
        this.ctx.state.setPhase('idle')
      }
      return
    }
    if (stopReason === 'refusal') this.builder.notice(`${this.ctx.input.agent} refused to continue this turn.`)
    if (stopReason === 'max_tokens') this.builder.notice('The turn stopped at the model output limit.')
    if (stopReason === 'max_turn_requests') this.builder.notice('The turn stopped at the request limit.')
    this.ctx.state.setPhase('idle')
  }

  private onNotification(method: string, params: unknown): void {
    if (this.disposed) return
    if (method !== 'session/update' || !isJsonObject(params)) return
    const update = params['update']
    if (!isJsonObject(update)) return
    const kind = update['sessionUpdate']
    // A released turn is still running in the runtime. Its turn content must
    // not leak into the replacement turn; runtime-level config updates still
    // flow so the pin invariant is restored.
    if (this.releasedPrompts.size > 0
      && kind !== 'config_option_update' && kind !== 'current_mode_update') return
    if (kind !== 'user_message_chunk') this.flushUser()
    switch (kind) {
      case 'user_message_chunk':
        // prompt() already appended this turn's user message. ACP runtimes
        // such as Grok echo it; only history replay should append these chunks.
        if (this.turnActive) break
        this.pendingUserText = `${this.pendingUserText ?? ''}${contentBlockText(update['content'])}`
        break
      case 'agent_message_chunk':
        this.builder.text(contentBlockText(update['content']))
        break
      case 'agent_thought_chunk':
        this.builder.thinking(contentBlockText(update['content']))
        break
      case 'tool_call': {
        const id = stringOrNull(update['toolCallId'])
        if (!id) break
        this.builder.toolCall(id, toolTitle(update), update['rawInput'] ?? {})
        this.applyToolStatus(id, update)
        break
      }
      case 'tool_call_update': {
        const id = stringOrNull(update['toolCallId'])
        if (!id) break
        const name = stringOrNull(update['title'])
        this.builder.toolCallUpdate(id, {
          ...(name ? { name } : {}),
          ...(update['rawInput'] !== undefined ? { args: update['rawInput'] } : {}),
        })
        this.applyToolStatus(id, update)
        break
      }
      case 'config_option_update':
        this.applyConfigOptions(update)
        this.schedulePinRestore()
        break
      case 'current_mode_update': {
        // A runtime-initiated mode switch must not silently drift the
        // app-owned pin. Update the projected option, then re-apply.
        const currentModeId = stringOrNull(update['currentModeId'])
        const mode = this.findPinnedOption('mode')
        if (currentModeId && mode) {
          this.ctx.state.setConfigOptions(this.ctx.state.configOptions.map((option) =>
            option.id === mode.id ? { ...option, currentValue: currentModeId } : option))
        }
        this.schedulePinRestore()
        break
      }
      default:
        // plan, available_commands_update
        break
    }
  }

  private schedulePinRestore(): void {
    const generation = this.turnGeneration
    void this.restoreConfigPin().catch((error: unknown) => {
      const message = `could not restore the pinned ${this.ctx.input.agent} config: ${error instanceof Error ? error.message : String(error)}`
      this.ctx.logger.warn(message)
      // A mid-turn drift must not keep executing tools under the wrong
      // model/effort/mode for the rest of the turn. Ignore a restore that
      // outlived the turn it was scheduled for.
      if (this.turnActive && generation === this.turnGeneration && !this.ctx.channel.closed) {
        // Stop the runtime too: finishTurn only clears local state, so the
        // agent would otherwise keep executing tools under the drifted config.
        void this.abort().catch((abortError: unknown) => {
          this.ctx.logger.warn(`could not cancel the drifted ${this.ctx.input.agent} turn: ${abortError instanceof Error ? abortError.message : String(abortError)}`)
        })
        this.releaseTurn(generation, new Error(message))
        this.ctx.state.fail(message)
      }
    })
  }

  /** Re-assert the app-owned pin after a runtime-initiated config or mode
   *  notification. A notification that lands during an in-flight restore sets
   *  a dirty flag; the running pass repeats (bounded) instead of dropping it.
   *  Errors are logged here; prompt()/respond() call ensureConfigPin() and
   *  fail closed instead of running with a drifted model/effort/mode. */
  private async restoreConfigPin(depth = 0): Promise<void> {
    if (!this.ctx.input.configPin) return
    if (this.pinRestoreRunning) {
      this.pinRestorePending = true
      await this.pinRestoreRunning
      if (this.pinRestorePending && depth < 2) {
        this.pinRestorePending = false
        await this.restoreConfigPin(depth + 1)
      }
      return
    }
    this.pinRestoreRunning = this.runPinRestore()
    try {
      await this.pinRestoreRunning
    } finally {
      this.pinRestoreRunning = null
    }
  }

  private async runPinRestore(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) {
      this.pinRestorePending = false
      await this.applyConfigPin()
      if (!this.pinRestorePending) return
    }
    throw new Error(`could not stabilize the pinned ${this.ctx.input.agent} config after 3 attempts`)
  }

  /** Fail closed at the next app action if the pin cannot be restored. */
  private async ensureConfigPin(): Promise<void> {
    if (!this.ctx.input.configPin) return
    try {
      await this.restoreConfigPin()
    } catch (error: unknown) {
      // Callers own the state transition: respond()/schedulePinRestore() only
      // fail the turn after checking the generation, and prompt() fails the
      // turn it just claimed. Failing here can mark a finished/new turn failed.
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /** Store runtime-advertised config selects (model/effort/mode). */
  private applyConfigOptions(value: unknown): void {
    const options = configOptionsFrom(value)
    if (options.length > 0) {
      this.ctx.state.setConfigOptions(options)
      for (const kind of ['mode', 'model', 'effort'] as const) {
        if (this.findPinnedOption(kind)) this.advertisedPinOptions.add(kind)
      }
    } else if (isJsonObject(value) && Array.isArray(value['configOptions'])) {
      // Any payload carrying the option set replaces it, even when every entry
      // was filtered out. Leaving stale selects would make the pin check pass
      // against an option the runtime no longer advertises.
      // Keep advertisedPinOptions: a pinned kind that was offered and then
      // disappeared is drift, not a runtime that never supported it.
      this.ctx.state.setConfigOptions([])
    }
  }

  /** Apply the adapter-owned invariant after session/new or session/load.
   *  Model/effort may be absent when the process-local overlay already set
   *  them; mode is app-owned, so a missing mode option fails closed. An
   *  offered option with an unavailable pinned value always fails closed. */
  private async applyConfigPin(skipMode = false): Promise<void> {
    const pin = this.ctx.input.configPin
    if (!pin) return
    if (pin.mode && !skipMode) {
      const mode = this.findPinnedOption('mode')
      if (!mode) {
        throw new Error(`${this.ctx.input.agent} did not offer the pinned session mode ${pin.mode}`)
      }
      if (!mode.options.some((entry) => entry.value === pin.mode)) {
        throw new Error(`${this.ctx.input.agent} does not offer the pinned session mode ${pin.mode}`)
      }
      if (mode.currentValue !== pin.mode) await this.configure(mode.id, pin.mode)
    }
    const model = this.findPinnedOption('model')
    if (pin.model) {
      if (!model) {
        // An option that was advertised and then disappeared is runtime drift,
        // not a runtime that never supported model selection. Fail closed.
        if (this.advertisedPinOptions.has('model')) {
          throw new Error(`${this.ctx.input.agent} removed the pinned model option ${pin.model}`)
        }
        this.ctx.logger.warn(`${this.ctx.input.agent} did not advertise a model option; the pinned model may not be applied`)
      } else {
        if (!model.options.some((entry) => entry.value === pin.model)) {
          throw new Error(`${this.ctx.input.agent} does not offer the pinned model ${pin.model}`)
        }
        if (model.currentValue !== pin.model) await this.configure(model.id, pin.model)
      }
    }
    const effort = this.findPinnedOption('effort')
    if (pin.reasoningEffort) {
      if (!effort) {
        if (this.advertisedPinOptions.has('effort')) {
          throw new Error(`${this.ctx.input.agent} removed the pinned effort option ${pin.reasoningEffort}`)
        }
        this.ctx.logger.warn(`${this.ctx.input.agent} did not advertise an effort option; the pinned effort may not be applied`)
      } else {
        if (!effort.options.some((entry) => entry.value === pin.reasoningEffort)) {
          throw new Error(`${this.ctx.input.agent} does not offer the pinned effort ${pin.reasoningEffort}`)
        }
        if (effort.currentValue !== pin.reasoningEffort) await this.configure(effort.id, pin.reasoningEffort)
      }
    }
  }

  private findPinnedOption(kind: PinKind): WebSessionConfigOption | undefined {
    const matcher = PINNED_OPTION_MATCHERS[kind]
    return this.ctx.state.configOptions.find((option) =>
      matcher.ids.includes(option.id)
      || (option.category !== undefined && matcher.categories.includes(option.category)))
  }

  private pinnedValueFor(option: WebSessionConfigOption): string | undefined {
    const pin = this.ctx.input.configPin
    if (!pin) return undefined
    for (const kind of PIN_KINDS) {
      const matcher = PINNED_OPTION_MATCHERS[kind]
      if (matcher.ids.includes(option.id)
        || (option.category !== undefined && matcher.categories.includes(option.category))) {
        return matcher.value(pin)
      }
    }
    return undefined
  }

  private applyToolStatus(id: string, update: JsonObject): void {
    const status = update['status']
    if (status !== 'completed' && status !== 'failed') return
    const content = toolCallContent(update['content'])
    const output = content.length > 0
      ? content
      : update['rawOutput'] !== undefined
        ? [{ type: 'data', value: update['rawOutput'] } satisfies WebContentPart]
        : ''
    this.builder.toolResult(id, output, status === 'failed')
  }

  private async onRequest(method: string, params: unknown, id: string | number): Promise<unknown> {
    if (this.disposed) throw new Error('ACP session stopped')
    if (method === 'session/request_permission' && isJsonObject(params)) {
      // A permission request from a cancelled or released (zombie) turn must
      // not drive the live session; answer it as cancelled.
      if (this.cancelRequested || this.releasedPrompts.size > 0) {
        this.ctx.logger.warn(`${this.ctx.input.agent} requested permission for a cancelled turn; cancelling it`)
        return { outcome: { outcome: 'cancelled' } }
      }
      return this.requestPermission(params, id)
    }
    const error = new Error(`OpenAlice does not implement ${method}`) as Error & { code: number }
    error.code = -32601
    throw error
  }

  private requestPermission(params: JsonObject, rpcId: string | number): Promise<JsonObject> {
    const toolCall = isJsonObject(params['toolCall']) ? params['toolCall'] : {}
    const requestId = `acp-${String(rpcId)}`
    const options = Array.isArray(params['options'])
      ? params['options'].flatMap((option): WebRequestOption[] => {
          if (!isJsonObject(option)) return []
          const optionId = stringOrNull(option['optionId'])
          if (!optionId) return []
          return [{ id: optionId, label: stringOrNull(option['name']) ?? optionId, tone: toneFromKind(option['kind']) }]
        })
      : []
    const toolName = toolTitle(toolCall)
    const request: WebPermissionRequest = {
      id: requestId,
      kind: 'permission',
      title: toolName === 'tool' ? `${this.ctx.input.agent} requests permission` : toolName,
      description: `${this.ctx.input.agent} wants to run this tool.`,
      tool: { name: toolName, input: toolCall['rawInput'] ?? {} },
      options: options.length > 0
        ? options
        : [{ id: 'allow', label: 'Allow', tone: 'allow' }, { id: 'reject', label: 'Reject', tone: 'deny' }],
      createdAt: Date.now(),
    }
    return new Promise<JsonObject>((resolve) => {
      this.permissions.set(requestId, { rpcId, resolve })
      this.ctx.state.addRequest(request)
    })
  }

  private cancelPermission(requestId: string): void {
    const pending = this.permissions.get(requestId)
    if (!pending) return
    this.permissions.delete(requestId)
    this.ctx.state.removeRequest(requestId)
    pending.resolve({ outcome: { outcome: 'cancelled' } })
  }

  private cancelPermissions(): void {
    for (const requestId of [...this.permissions.keys()]) this.cancelPermission(requestId)
  }

  private flushUser(): void {
    if (this.pendingUserText === null) return
    const text = this.pendingUserText
    this.pendingUserText = null
    if (text.trim()) this.builder.user(text)
  }
}

function toolTitle(record: JsonObject): string {
  return stringOrNull(record['title']) ?? stringOrNull(record['kind']) ?? 'tool'
}

function toneFromKind(kind: unknown): WebRequestOptionTone {
  if (kind === 'allow_once' || kind === 'allow_always') return 'allow'
  if (kind === 'reject_once' || kind === 'reject_always') return 'deny'
  return 'neutral'
}

function contentBlockText(block: unknown): string {
  if (!isJsonObject(block)) return ''
  if (block['type'] === 'text') return stringOrNull(block['text']) ?? ''
  if (block['type'] === 'resource_link') return stringOrNull(block['uri']) ?? ''
  if (block['type'] === 'resource' && isJsonObject(block['resource'])) return stringOrNull(block['resource']['text']) ?? ''
  return ''
}

function toolCallContent(value: unknown): WebContentPart[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): WebContentPart[] => {
    if (!isJsonObject(entry)) return []
    if (entry['type'] === 'content') {
      const text = contentBlockText(entry['content'])
      return text ? [{ type: 'text', text }] : []
    }
    if (entry['type'] === 'diff') {
      const path = stringOrNull(entry['path']) ?? 'file'
      const oldText = stringOrNull(entry['oldText'])
      const newText = stringOrNull(entry['newText']) ?? ''
      return [{ type: 'text', text: `Edited ${path}\n\n\`\`\`diff\n${diffPreview(oldText, newText)}\n\`\`\`` }]
    }
    if (entry['type'] === 'terminal') return [{ type: 'data', value: entry }]
    return [{ type: 'data', value: entry }]
  })
}

function diffPreview(oldText: string | null, newText: string): string {
  const removed = oldText ? oldText.split('\n').map((line) => `- ${line}`) : []
  const added = newText.split('\n').map((line) => `+ ${line}`)
  return [...removed, ...added].join('\n')
}

function configOptionsFrom(value: unknown): WebSessionConfigOption[] {
  if (!isJsonObject(value)) return []
  const raw = value['configOptions']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): WebSessionConfigOption[] => {
    if (!isJsonObject(entry) || entry['type'] !== 'select') return []
    const id = stringOrNull(entry['id'])
    const name = stringOrNull(entry['name'])
    const currentValue = stringOrNull(entry['currentValue'])
    if (!id || !name || currentValue === null) return []
    const description = stringOrNull(entry['description'])
    const category = stringOrNull(entry['category'])
    const options = Array.isArray(entry['options'])
      ? entry['options'].flatMap((option): WebSessionConfigOption['options'][number][] => {
          if (!isJsonObject(option)) return []
          const optionValue = stringOrNull(option['value'])
          const optionName = stringOrNull(option['name'])
          if (optionValue === null || optionName === null) return []
          const optionDescription = stringOrNull(option['description'])
          return [{
            value: optionValue,
            name: optionName,
            ...(optionDescription ? { description: optionDescription } : {}),
          }]
        })
      : []
    return [{
      id,
      name,
      type: 'select',
      currentValue,
      options,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
    }]
  })
}

function describeAcpFailure(error: unknown, agent: string): Error {
  const rpc = error as Partial<JsonRpcError>
  if (rpc.code === -32000 || /auth/i.test(rpc.message ?? '')) {
    return new Error(`${agent} requires authentication before it can open a Web session: ${rpc.message ?? 'auth required'}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}
