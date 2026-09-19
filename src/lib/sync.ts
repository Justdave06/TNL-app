import NetInfo from '@react-native-community/netinfo'
import * as Crypto from 'expo-crypto'
import { AppState } from 'react-native'
import * as db from './db'
import * as remote from './remote'
import { readSessionUserId, writeSessionUserId } from './session'
import type {
  ActivatePhysicalCardOpPayload,
  RedeemVoucherOpPayload,
  RegisterUserOpPayload,
  SpendAwardsOpPayload,
  SyncOp,
  SyncOpResult,
} from './syncTypes'

/**
 * Offline-first sync engine.
 *
 * The authoritative server (`server/`) is the source of truth. This module
 * pushes the device's queued ops (idempotent by client `opId`), reconciles the
 * per-op results (rolls back rejected provisional writes, adds notices), then
 * pulls the role-scoped snapshot and swaps it into the local cache.
 *
 * Connection is tracked with NetInfo + AppState; whenever the app is active and
 * a network comes back a sync attempt runs automatically.
 */

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'needs-login'

export interface SyncStatus {
  state: SyncState
  syncing: boolean
  /** Ops still waiting for the next push. */
  pendingCount: number
  /** Epoch ms of the last successful pull (or null before the first). */
  lastSyncAt: number | null
  lastError: string | null
}

/** Per-install id used to tag every op's origin (audit only). */
const DEVICE_ID = Crypto.randomUUID()

export function getDeviceId(): string {
  return DEVICE_ID
}

let status: SyncStatus = {
  state: 'idle',
  syncing: false,
  pendingCount: 0,
  lastSyncAt: null,
  lastError: null,
}

const listeners = new Set<(current: SyncStatus) => void>()
let syncing = false

function setStatus(partial: Partial<SyncStatus>): void {
  status = { ...status, ...partial }
  for (const listener of [...listeners]) listener(status)
}

export function getSyncStatus(): SyncStatus {
  return { ...status }
}

export function subscribeSync(listener: (current: SyncStatus) => void): () => void {
  listeners.add(listener)
  listener(status)
  return () => {
    listeners.delete(listener)
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export async function isOnline(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch()
    return state.isConnected === true && state.isInternetReachable !== false
  } catch {
    return false
  }
}

export async function refreshPendingCount(): Promise<void> {
  setStatus({ pendingCount: await db.countPendingOps() })
}

/** A fresh op for the local write queue. */
interface OpsByType {
  register_user: RegisterUserOpPayload
  redeem_voucher: RedeemVoucherOpPayload
  activate_physical_card: ActivatePhysicalCardOpPayload
  spend_awards: SpendAwardsOpPayload
}

export function makeOp<T extends keyof OpsByType>(type: T, payload: OpsByType[T]): SyncOp {
  return { opId: Crypto.randomUUID(), type, createdAt: Date.now(), deviceId: DEVICE_ID, payload }
}

/* -------------------------------------------------------------------------- */
/* The sync pass                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Runs one full sync (push queued ops, then pull the cache fresher). Safe to
 * call from anywhere; overlapping runs coalesce into a single pass.
 */
export async function syncNow(): Promise<void> {
  if (syncing) return
  syncing = true
  setStatus({ state: 'syncing', syncing: true, lastError: null })
  try {
    if (!(await isOnline())) {
      await refreshPendingCount()
      setStatus({ state: 'offline', syncing: false })
      return
    }

    const userId = await readSessionUserId()
    if (!userId) {
      await refreshPendingCount()
      setStatus({ state: 'idle', syncing: false })
      return
    }

    const auth = await ensureServerAuth(userId)
    if (auth === 'needs-login') {
      await refreshPendingCount()
      setStatus({ state: 'needs-login', syncing: false })
      return
    }

    const ops = await db.listPendingOps()
    if (ops.length > 0) {
      const continued = await pushAndReconcile(userId, ops)
      if (!continued) return
    }

    // A freshly queued registration (still unsynced) has nothing to pull yet.
    const canPull = auth !== 'pending-register' || (await remote.hasAuthCookie())
    if (canPull) {
      const pulled = await pullAndRebind(userId)
      if (pulled === 'needs-login') return
    }

    await refreshPendingCount()
    setStatus({ state: 'idle', syncing: false })
  } catch (error) {
    await refreshPendingCount()
    setStatus({ state: 'error', syncing: false, lastError: toMessage(error) })
  } finally {
    syncing = false
  }
}

/** Re-authenticates the device before pushing; returns the auth mode. */
async function ensureServerAuth(userId: string): Promise<'ok' | 'needs-login' | 'pending-register'> {
  if (await remote.hasAuthCookie()) return 'ok'

  const ops = await db.listPendingOps()
  const waitingOnRegister = ops.some(
    (op) => op.type === 'register_user' && op.payload.userId === userId,
  )
  // A customer whose registration is still queued has no server account yet, so
  // the anonymous bootstrap push is what creates it (and returns a cookie).
  if (waitingOnRegister) return 'pending-register'

  const cred = await remote.getSyncCred()
  if (cred) {
    try {
      await remote.authorize(cred.phone, cred.pin)
      return 'ok'
    } catch (error) {
      if (error instanceof remote.RemoteError && error.status === 401) {
        await remote.clearSyncCred()
        return 'needs-login'
      }
      throw error
    }
  }
  return 'needs-login'
}

async function pushAndReconcile(userId: string, ops: SyncOp[]): Promise<boolean> {
  let results: SyncOpResult[]
  try {
    results = (await remote.pushOps(ops)).results
  } catch (error) {
    if (error instanceof remote.RemoteError && error.status === 401) {
      await remote.setStoredAuthCookie(null)
      await refreshPendingCount()
      setStatus({ state: 'needs-login', syncing: false, lastError: 'Sign in again to sync' })
      return false
    }
    throw error
  }

  await reconcileResults(userId, ops, results)
  return true
}

/** Falls back gracefully to a new local op id when the server rejects. */
async function reconcileResults(userId: string, ops: SyncOp[], results: SyncOpResult[]): Promise<void> {
  const byId = new Map(results.map((result) => [result.opId, result]))
  for (const op of ops) {
    const result = byId.get(op.opId)
    if (!result) continue // still held/pending on the server - keep it queued
    if (result.ok) await acceptOp(op, result)
    else await rejectOp(op, result)
    await db.deletePendingOp(op.opId)
  }
  void userId
}

async function acceptOp(op: SyncOp, result: SyncOpResult): Promise<void> {
  if (op.type === 'register_user') {
    await db.clearUserPendingByOp(op.opId)
    // The bootstrap register returns a session cookie so the next pull works.
    if (result.ok && result.state?.authCookie) {
      await remote.setStoredAuthCookie(result.state.authCookie)
    }
  } else if (op.type === 'activate_physical_card') {
    await db.clearPhysicalCardPendingByOp(op.opId)
  } else if (op.type === 'spend_awards') {
    const payload = op.payload as SpendAwardsOpPayload
    await db.deleteAwardsByIds(payload.awardIds)
    await db.removeSpendReservation(op.opId)
    await db.recomputeUserPoints(payload.userId)
  }
  // redeem_voucher: submission only - the pulled snapshot brings the award.
}

async function rejectOp(op: SyncOp, result: Extract<SyncOpResult, { ok: false }>): Promise<void> {
  const titles: Record<SyncOp['type'], string> = {
    register_user: 'Registration not completed',
    redeem_voucher: 'Card code not accepted',
    activate_physical_card: 'Card not activated',
    spend_awards: 'Redemption failed',
  }
  await db.addNotice({ title: titles[op.type], message: result.message, kind: 'rejected' })

  if (op.type === 'register_user') {
    const sessionUserId = await readSessionUserId()
    if (sessionUserId === op.payload.userId) await writeSessionUserId(null)
    await db.dropUserById(op.payload.userId)
  } else if (op.type === 'activate_physical_card') {
    await db.deletePhysicalCardByOp(op.opId)
  } else if (op.type === 'spend_awards') {
    await db.removeSpendReservation(op.opId)
  }
}

async function pullAndRebind(userId: string): Promise<'ok' | 'needs-login'> {
  let snapshot: Awaited<ReturnType<typeof remote.pullSnapshot>>
  try {
    snapshot = await remote.pullSnapshot()
  } catch (error) {
    if (error instanceof remote.RemoteError && error.status === 401) {
      await remote.setStoredAuthCookie(null)
      await refreshPendingCount()
      setStatus({ state: 'needs-login', syncing: false, lastError: 'Sign in again to sync' })
      return 'needs-login'
    }
    throw error
  }

  await db.applySyncSnapshot(snapshot)

  // The server is authoritative about ids, so re-point the session at the
  // server copy of the same phone, and re-sync the points cache.
  const local = await db.getUserById(userId)
  if (local) {
    const fresh = await db.getUserByPhone(local.phone)
    if (fresh && fresh.id !== userId) await writeSessionUserId(fresh.id)
  }

  setStatus({ lastSyncAt: snapshot.serverTime })
  return 'ok'
}

/* -------------------------------------------------------------------------- */
/* Automatic sync                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Watches connectivity and app foregrounding so a sync runs whenever the device
 * can reach the server. Returns a cleanup function for unmount.
 */
export function activateAutoSync(): () => void {
  // Prime lastSyncAt when the cache already has one.
  void db
    .getMeta('lastSyncAt')
    .then((value) => {
      const lastSyncAt = value ? Number(value) : null
      if (lastSyncAt) setStatus({ lastSyncAt })
    })
    .catch(() => undefined)
  void refreshPendingCount()

  const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
    if (state.isConnected === true && state.isInternetReachable !== false) void syncNow()
  })
  const appStateSubscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') void syncNow()
  })
  return () => {
    unsubscribeNetInfo()
    appStateSubscription.remove()
  }
}