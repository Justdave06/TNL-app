import * as Crypto from 'expo-crypto'
import * as db from './db'
import {
  MAX_PHYSICAL_BATCH_SIZE,
  MAX_VOUCHER_BATCH_SIZE,
  REWARD_MIN_POINTS,
  VOUCHER_POINT_TIERS,
  buildRewardPayload,
  discountPercentForPoints,
  isVoucherTier,
  normalizeVoucherCode,
  parsePhysicalCardQrPayload,
  parseRewardPayload,
  toRewardQrAwards,
  type ActivatePhysicalCardResponse,
  type CreatePhysicalCardsResponse,
  type CreateVoucherBatchResponse,
  type CurrentUser,
  type DeleteVouchersResponse,
  type PhysicalCardBatchCardsResponse,
  type PhysicalCardBatchesResponse,
  type RedeemRewardResponse,
  type RedeemVoucherResponse,
  type VoucherBatchesResponse,
  type VoucherCardsByPointsResponse,
  type VoucherCardsResponse,
} from './loyalty'
import { verifyPin } from './pin'
import * as remote from './remote'
import { readSessionUserId, writeSessionUserId } from './session'
import * as sync from './sync'
import type { RedeemVoucherOpPayload } from './syncTypes'

/**
 * Data access layer for the offline-first build.
 *
 * Reads come from the on-device SQLite cache (`src/lib/db.ts`); writes go to
 * the authoritative server when they can, and otherwise queue as sync ops that
 * replay when connectivity returns. Every function keeps its original name,
 * signature, return type and error wording from the online build, so the UI is
 * untouched by the offline/online split.
 *
 * The signed-cookie session is a stored user id in AsyncStorage plus the
 * server cookie kept by `remote.ts`; role checks (`requireUser`/`requireAdmin`)
 * run exactly as before.
 */

/** 9-11 digits starting with 0, e.g. 01012345678. */
const PHONE_PATTERN = /^0\d{8,10}$/

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function toApiError(error: unknown, offlineMessage?: string): never {
  if (error instanceof remote.RemoteError) {
    if (error.status === 0) {
      throw new ApiError(503, offlineMessage ?? 'You are offline - please try again when connected')
    }
    throw new ApiError(error.status, error.message)
  }
  if (error instanceof ApiError) throw error
  throw new ApiError(500, error instanceof Error ? error.message : 'Something went wrong')
}

/* -------------------------------------------------------------------------- */
/* Local session                                                              */
/* -------------------------------------------------------------------------- */

/** Resolves the signed-in user or throws 401. */
async function requireUser(): Promise<db.UserRow> {
  const userId = await readSessionUserId()
  if (!userId) throw new ApiError(401, 'Please sign in')
  const user = await db.getUserById(userId)
  if (!user) throw new ApiError(401, 'Session is no longer valid - please sign in again')
  return user
}

/** Resolves the signed-in user and enforces the admin role, or throws. */
async function requireAdmin(): Promise<db.UserRow> {
  const user = await requireUser()
  if (user.role !== 'admin') throw new ApiError(403, 'Admin access required')
  return user
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

async function finishOnlineAuth(auth: remote.AuthBody, phone: string): Promise<CurrentUser> {
  const user = await db.upsertUser({
    id: auth.id,
    phone: auth.phone ?? phone,
    name: auth.name,
    points: auth.points,
    ref_code: auth.ref_code,
    role: auth.role === 'admin' ? 'admin' : 'customer',
    pin_hash: '',
    pending_op: null,
  })
  await writeSessionUserId(user.id)
  await remote.setSyncCred(phone, '')
  return db.toCurrentUser(user)
}

export async function login(phone: string, pin: string): Promise<CurrentUser> {
  const cleanPhone = phone.replace(/\D/g, '')
  const cleanPin = pin.trim()

  if (!cleanPhone || !cleanPin) {
    throw new ApiError(400, 'Phone number and PIN are required')
  }

  if (await sync.isOnline()) {
    try {
      const auth = await remote.authorize(cleanPhone, cleanPin)
      const user = await finishOnlineAuth(auth, cleanPhone)
      void sync.syncNow()
      return user
    } catch (error) {
      // No network (or the server rejected these creds): fall back to the
      // local cache so the app still opens offline.
      if (error instanceof remote.RemoteError && error.status !== 401) throw toApiError(error)
      if (!(error instanceof remote.RemoteError)) throw error
    }
  }

  const user = await db.getUserByPhone(cleanPhone)
  if (!user || !(await verifyPin(cleanPin, user.pin_hash))) {
    throw new ApiError(401, 'Invalid phone number or PIN')
  }

  await writeSessionUserId(user.id)
  await remote.setSyncCred(cleanPhone, cleanPin)
  void sync.syncNow()
  return db.toCurrentUser(user)
}

export async function register(name: string, phone: string, pin: string): Promise<CurrentUser> {
  const cleanName = name.trim().replace(/\s+/g, ' ')
  const cleanPhone = phone.replace(/\D/g, '')
  const cleanPin = pin.trim()

  if (!cleanName || !cleanPhone || !cleanPin) {
    throw new ApiError(400, 'Name, phone number and PIN are required')
  }
  if (cleanName.length > 40) {
    throw new ApiError(400, 'Name must be 40 characters or fewer')
  }
  if (!PHONE_PATTERN.test(cleanPhone)) {
    throw new ApiError(400, 'Enter a valid phone number')
  }
  if (!/^\d{4,6}$/.test(cleanPin)) {
    throw new ApiError(400, 'PIN must be 4 to 6 digits')
  }

  if (await sync.isOnline()) {
    try {
      const auth = await remote.registerRemote(cleanName, cleanPhone, cleanPin)
      const user = await finishOnlineAuth(auth, cleanPhone)
      void sync.syncNow()
      return user
    } catch (error) {
      throw toApiError(error, 'Could not reach the server - please try again')
    }
  }

  // Offline: queue the registration and show it immediately (pending).
  const opId = Crypto.randomUUID()
  const result = await db.createCustomerProvisional({
    name: cleanName,
    phone: cleanPhone,
    pin: cleanPin,
    opId,
    deviceId: sync.getDeviceId(),
  })
  if (!result.ok) {
    throw new ApiError(409, 'That phone number is already registered')
  }

  await db.insertPendingOp(result.op)
  await writeSessionUserId(result.user.id)
  await remote.setSyncCred(cleanPhone, cleanPin)
  void sync.syncNow()
  return db.toCurrentUser(result.user)
}

export async function logout(): Promise<void> {
  await remote.revokeSession()
  await writeSessionUserId(null)
}

export async function fetchMe(): Promise<CurrentUser> {
  const user = await requireUser()
  return db.toCurrentUser(user)
}

/* -------------------------------------------------------------------------- */
/* Customer                                                                   */
/* -------------------------------------------------------------------------- */

export async function redeemVoucher(code: string): Promise<RedeemVoucherResponse> {
  const user = await requireUser()

  const normalized = normalizeVoucherCode(code)
  if (!normalized) {
    throw new ApiError(
      400,
      'That is not a valid rewards kode — vouchers start with RMY, e.g. RMY-4K7P-2XQ9',
    )
  }

  if (await sync.isOnline()) {
    try {
      const response = (await remote.postRedeem(normalized)) as RedeemVoucherResponse
      void sync.syncNow()
      return response
    } catch (error) {
      if (error instanceof remote.RemoteError) {
        if (error.status === 0) {
          // Server unreachable mid-flight - fall through to the offline queue.
        } else if (!(error.status === 409 || error.status === 404)) {
          throw toApiError(error)
        } else {
          throw new ApiError(error.status, error.message)
        }
      } else {
        throw error
      }
    }
  }

  // Offline: a code submission is queued; points land after the next sync.
  const pendingOps = await db.listPendingOps()
  if (pendingOps.some((op) => op.type === 'redeem_voucher' && (op.payload as RedeemVoucherOpPayload).code === normalized)) {
    throw new ApiError(409, 'That card has already been used')
  }

  const op = sync.makeOp('redeem_voucher', {
    userId: user.id,
    code: normalized,
    awardId: Crypto.randomUUID(),
    awardedAt: Date.now(),
  })
  await db.insertPendingOp(op)
  void sync.syncNow()

  return {
    success: true,
    code: normalized,
    pointsAdded: 0,
    newBalance: user.points,
    expiresAt: 0,
    pending: true,
  }
}

export async function activatePhysicalCard(code: string): Promise<ActivatePhysicalCardResponse> {
  const user = await requireUser()

  const kode = parsePhysicalCardQrPayload(code)
  if (!kode) {
    throw new ApiError(400, 'That is not a TNL card kode - check the code printed on the card')
  }

  if (await sync.isOnline()) {
    try {
      const response = (await remote.postActivate(kode)) as ActivatePhysicalCardResponse
      void sync.syncNow()
      return response
    } catch (error) {
      if (error instanceof remote.RemoteError) {
        if (error.status === 0) {
          // Fall through to the offline queue.
        } else {
          throw new ApiError(error.status, error.message)
        }
      } else {
        throw error
      }
    }
  }

  // Offline: claim the card locally as pending; the pull confirms it.
  const op = sync.makeOp('activate_physical_card', { userId: user.id, kode })
  const result = await db.activatePhysicalCardProvisional({ kode, userId: user.id, opId: op.opId })
  if (!result.ok) {
    if (result.reason === 'already_activated') {
      throw new ApiError(409, 'That card has already been activated by another account')
    }
    throw new ApiError(404, 'Account not found')
  }

  await db.insertPendingOp(op)
  void sync.syncNow()

  return {
    success: true,
    code: kode,
    activatedAt: Date.now(),
    pending: true,
  }
}

/* -------------------------------------------------------------------------- */
/* Admin scanning                                                             */
/* -------------------------------------------------------------------------- */

export async function redeemReward(code: string): Promise<RedeemRewardResponse> {
  const admin = await requireAdmin()

  const raw = typeof code === 'string' ? code.trim() : ''
  const scan = parseRewardPayload(raw)
  const kode = scan == null ? parsePhysicalCardQrPayload(raw) : null

  let userId = ''
  let customerName = ''
  let awards: db.PointAwardRow[] = []
  let fromSnapshot = false

  if (scan) {
    userId = scan.userId
    customerName = scan.name ?? ''
    if (scan.awards && scan.awards.length > 0) {
      // Rewards QR with a point-by-point snapshot: spend exactly those awards.
      fromSnapshot = true
      awards = scan.awards.map((award) => ({
        id: award.id,
        user_id: userId,
        points: award.points,
        awarded_at: '',
        expires_at: new Date(award.expiresAt).toISOString(),
        source: 'voucher' as const,
        voucher_code: null,
        spent_at: null,
        pending_op: null,
      }))
    }
  } else if (kode) {
    const card = await db.resolvePhysicalCardOwner(kode)
    if (!card.ok) {
      throw new ApiError(
        404,
        card.reason === 'not_activated'
          ? 'That card has not been activated yet - the customer must activate it first'
          : 'That card kode was not recognised - please check it',
      )
    }
    userId = card.userId
  }

  if (!userId) {
    throw new ApiError(400, 'Scan the customer\u2019s reward QR, their TNL card, or enter a customer id')
  }

  if (!fromSnapshot) {
    const resolved = await db.getUserById(userId)
    customerName = resolved?.name ?? 'Customer'
    awards = await db.getLiveAwards(userId)
  }

  // Reserved award ids were already spent by an earlier offline scan; a replay
  // of the same snapshot therefore shows the new, smaller surviving balance.
  const reserved = await db.listReservedAwardIds()
  const active = awards.filter(
    (award) => !reserved.has(award.id) && new Date(award.expires_at).getTime() > Date.now(),
  )
  const available = active.reduce((sum, award) => sum + award.points, 0)
  if (available < REWARD_MIN_POINTS) {
    throw new ApiError(
      400,
      `This customer needs at least ${REWARD_MIN_POINTS} points to claim - they only have ${available}`,
    )
  }

  const op = sync.makeOp('spend_awards', {
    adminUserId: admin.id,
    userId,
    awardIds: active.map((award) => award.id),
    capturedAt: Date.now(),
  })
  await db.addSpendReservation({ opId: op.opId, userId, awardIds: active.map((award) => award.id), points: available })
  await db.insertPendingOp(op)
  void sync.syncNow()

  return {
    success: true,
    userId,
    customerName,
    remainingPoints: 0,
    discountApplied: `${discountPercentForPoints(available)}%`,
    pointsSpent: available,
    pending: true,
  }
}

export async function fetchCustomerCount(): Promise<number> {
  await requireAdmin()
  return db.countCustomers()
}

/* -------------------------------------------------------------------------- */
/* Admin catalog management (online-only)                                     */
/* -------------------------------------------------------------------------- */

async function ensureOnlineCatalog(): Promise<void> {
  if (!(await sync.isOnline())) {
    throw new ApiError(503, 'You need an internet connection to manage the catalog')
  }
}

export async function createVoucherBatch(
  points: number,
  quantity: number,
): Promise<CreateVoucherBatchResponse> {
  await requireAdmin()

  if (!isVoucherTier(points)) {
    throw new ApiError(400, `Points must be one of ${VOUCHER_POINT_TIERS.join(', ')}`)
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_VOUCHER_BATCH_SIZE) {
    throw new ApiError(400, `Quantity must be between 1 and ${MAX_VOUCHER_BATCH_SIZE}`)
  }
  await ensureOnlineCatalog()

  try {
    const response = (await remote.postAdmin('/vouchers', { points, quantity })) as CreateVoucherBatchResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to mint new cards')
  }
}

export async function fetchVoucherBatches(): Promise<VoucherBatchesResponse> {
  await requireAdmin()
  await ensureOnlineCatalog()

  try {
    const response = (await remote.getAdmin('/vouchers')) as VoucherBatchesResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to view the catalog')
  }
}

export async function fetchVoucherCardsByPoints(
  points: number,
): Promise<VoucherCardsByPointsResponse> {
  await requireAdmin()
  await ensureOnlineCatalog()

  if (!isVoucherTier(points)) {
    throw new ApiError(400, 'Invalid points value')
  }

  try {
    const response = (await remote.getAdmin(
      `/vouchers/cards-by-points?points=${encodeURIComponent(points)}`,
    )) as VoucherCardsByPointsResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to view the catalog')
  }
}

export async function fetchVoucherCards(batchId: string): Promise<VoucherCardsResponse> {
  await requireAdmin()
  await ensureOnlineCatalog()

  try {
    const response = (await remote.getAdmin(`/vouchers/${encodeURIComponent(batchId)}`)) as VoucherCardsResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to view the catalog')
  }
}

export async function deleteClaimedVouchers(codes: string[]): Promise<DeleteVouchersResponse> {
  await requireAdmin()

  const normalized = (Array.isArray(codes) ? codes : [])
    .map((code) => normalizeVoucherCode(code))
    .filter((code): code is string => code !== null)

  if (normalized.length === 0) {
    throw new ApiError(400, 'No card kodes to delete')
  }
  await ensureOnlineCatalog()

  try {
    const response = (await remote.postAdmin('/vouchers/delete', { codes: normalized })) as DeleteVouchersResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to manage the catalog')
  }
}

export async function createPhysicalCardBatch(
  quantity: number,
): Promise<CreatePhysicalCardsResponse> {
  await requireAdmin()

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PHYSICAL_BATCH_SIZE) {
    throw new ApiError(400, `Quantity must be between 1 and ${MAX_PHYSICAL_BATCH_SIZE}`)
  }
  await ensureOnlineCatalog()

  try {
    const response = (await remote.postAdmin('/physical-cards', { quantity })) as CreatePhysicalCardsResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to mint new cards')
  }
}

export async function fetchPhysicalCardBatches(): Promise<PhysicalCardBatchesResponse> {
  await requireAdmin()
  await ensureOnlineCatalog()

  try {
    const response = (await remote.getAdmin('/physical-cards')) as PhysicalCardBatchesResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to view the catalog')
  }
}

export async function fetchPhysicalCardCards(
  batchId: string,
): Promise<PhysicalCardBatchCardsResponse> {
  await requireAdmin()
  await ensureOnlineCatalog()

  try {
    const response = (await remote.getAdmin(
      `/physical-cards/${encodeURIComponent(batchId)}`,
    )) as PhysicalCardBatchCardsResponse
    void sync.syncNow()
    return response
  } catch (error) {
    throw toApiError(error, 'You need an internet connection to view the catalog')
  }
}

/* -------------------------------------------------------------------------- */
/* Reward QR                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Builds the JSON string for the customer's reward QR. Includes the current
 * display name and a point-by-point snapshot of the live awards, so the
 * cashier's scanner works with no network and the snapshots are spent exactly.
 */
export async function buildRewardQr(): Promise<string> {
  const user = await requireUser()
  const awards = await db.getLiveAwards(user.id)
  return JSON.stringify(buildRewardPayload(user.id, { name: user.name, awards: toRewardQrAwards(awards) }))
}

/* -------------------------------------------------------------------------- */
/* Session helpers                                                            */
/* -------------------------------------------------------------------------- */

export async function hasStoredSession(): Promise<boolean> {
  const userId = await readSessionUserId()
  if (!userId) return false
  return (await db.getUserById(userId)) != null
}