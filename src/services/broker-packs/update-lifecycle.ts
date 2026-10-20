import { createUpdatePlan, projectUpdateUnit, type UpdatePlan, type UpdateOperation } from '@traderalice/update-lifecycle'
import { FileUpdateJournal } from '@traderalice/update-lifecycle/node'
import { brokerPackEngineRoot, resolveActiveBrokerPack, type InstallableBrokerEngine } from '../../core/broker-packs.js'
import { join } from 'node:path'
import { installBrokerPack, planBrokerPack, getBrokerPackLocalStatus } from './installer.js'
import { isUTADisabled, resolveUTAUrl } from '../uta-supervisor/url.js'
import { triggerUTARestart } from '../uta-supervisor/restart-trigger.js'
import { localAuthHeaders } from '../../server/local-auth.js'
import { assertLoopbackForLocalToken } from '@traderalice/uta-protocol'

/** A request/configuration failure that must not be mistaken for "the Pack is
 *  not loaded" (which would trigger a pointless UTA restart). */
class UtaRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UtaRequestError'
  }
}

export async function planBrokerPackUpdate(engine: InstallableBrokerEngine): Promise<UpdatePlan> {
  const [asset, installed] = await Promise.all([planBrokerPack(engine), getBrokerPackLocalStatus(engine)])
  const unit = projectUpdateUnit(`pack:${engine}`, 'broker-pack', brokerPackEngineRoot(engine), installed.version ? { version: installed.version } : null, { version: asset.version, artifactSha256: asset.sha256 })
  return createUpdatePlan(unit.id, [{ unit, fingerprint: asset.sha256, stages: ['apply', 'activate', 'verify'] }])
}
export function brokerPackUpdateJournal(engine: InstallableBrokerEngine): FileUpdateJournal {
  return new FileUpdateJournal(join(brokerPackEngineRoot(engine), 'lifecycle'), `pack:${engine}`)
}
export async function applyBrokerPackUpdate(engine: InstallableBrokerEngine, approved?: UpdatePlan): Promise<UpdateOperation> {
  const journal = brokerPackUpdateJournal(engine)
  let op = await journal.read()
  if (!op || op.phase === 'succeeded') {
    const plan = approved ?? await planBrokerPackUpdate(engine)
    await journal.approve(plan, plan.fingerprint)
  } else if (approved && op.plan.proposals[0]!.fingerprint !== approved.proposals[0]!.fingerprint) throw new Error('Resume the pending Broker Pack target first')
  const loaded = async (version: string, contentId: string): Promise<boolean> => {
    if (isUTADisabled()) return false
    let headers: Record<string, string>
    try {
      headers = await localAuthHeaders()
    } catch (error: unknown) {
      // A missing or unreadable token is not "pack not loaded"; surface the
      // real cause instead of triggering a pointless UTA restart.
      throw new UtaRequestError(`could not read the local auth token for UTA: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const baseUrl = resolveUTAUrl().replace(/\/$/, '')
      if (headers.authorization) {
        try {
          assertLoopbackForLocalToken(baseUrl)
        } catch (error: unknown) {
          throw new UtaRequestError(error instanceof Error ? error.message : String(error))
        }
      }
      const response = await fetch(`${baseUrl}/__uta/broker-packs/${engine}`, {
        signal: AbortSignal.timeout(5000),
        headers,
      })
      // UTA's local-auth middleware answers 401. A 403 is its origin guard
      // (or an unrelated proxy policy), not a bad token; fail without the
      // token/restart remedy instead of retrying the whole UTA process.
      if (response.status === 401) {
        throw new UtaRequestError('UTA rejected the local auth token; restart OpenAlice so both services share one token')
      }
      if (response.status === 403) {
        throw new UtaRequestError('UTA rejected the broker-pack request with 403 (origin policy), not a token failure; check the UTA URL/origin configuration')
      }
      const text = await response.text()
      let body: unknown = null
      try {
        body = text.trim() ? JSON.parse(text) : null
      } catch {
        body = null
      }
      if (!response.ok) {
        // A gateway/UTA 5xx or a plain-text error is a request failure, not
        // "Pack not loaded"; restarting UTA would not fix it.
        if (response.status >= 500) {
          throw new UtaRequestError(`UTA broker-pack probe failed with HTTP ${response.status}`)
        }
        if (body === null) {
          throw new UtaRequestError(`UTA returned HTTP ${response.status} with a non-JSON body`)
        }
        return false
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new UtaRequestError('UTA returned a non-JSON broker-pack response')
      }
      const identity = (body as { identity?: { version?: unknown; contentId?: unknown } }).identity
      return identity?.version === version && identity.contentId === contentId
    } catch (error: unknown) {
      if (error instanceof UtaRequestError) throw error
      return false
    }
  }
  return journal.run({
    reconcile: async (step, p, operation) => {
      const target = p.unit.desired!, content = p.fingerprint.slice(0, 16)
      const installed = await resolveActiveBrokerPack(engine).catch(() => null)
      if (step.stage === 'apply') return installed?.manifest.version === target.version && installed.manifest.contentId === content
        ? { status: 'complete', receipt: p.fingerprint } : { status: 'ready' }
      if (await loaded(target.version, content)) return { status: 'complete', receipt: `uta-loaded:${p.fingerprint}` }
      if (isUTADisabled()) return { status: 'waiting', reason: 'Pack installed; UTA is optional and currently disabled. Chat remains available.' }
      if (step.stage === 'verify') return { status: 'unknown', reason: 'UTA has not loaded the approved Pack; inspect its module error before retry' }
      return operation.inFlight === step.id ? { status: 'unknown', reason: 'UTA restart outcome is unknown; check its health before another restart' } : { status: 'ready' }
    },
    execute: async (step, p) => {
      if (step.stage === 'apply') { await installBrokerPack(engine, p.fingerprint); return { status: 'complete', receipt: p.fingerprint } }
      const result = await triggerUTARestart()
      return result.ready ? { status: 'complete', receipt: `uta:${result.newStartedAt}` } : { status: 'waiting', reason: result.error ?? 'Waiting for UTA restart' }
    },
  })
}
