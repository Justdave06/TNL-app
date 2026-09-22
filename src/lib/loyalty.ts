/**
 * Business rules and shared shapes for the TNL loyalty flow.
 * Ported from the web app's `shared/loyalty.ts` and kept framework-agnostic.
 */

/** Minimum balance needed before a discount can be claimed. */
export const REWARD_MIN_POINTS = 5

/** Balance cap: points cannot be collected past this until a claim resets it. */
export const MAX_POINT_BALANCE = 50

/** Points earned expire this many days after they land. */
export const POINTS_EXPIRY_DAYS = 7

/** Discount growth per point once the minimum is reached. */
export const DISCOUNT_PERCENT_PER_POINT = 2

/** Points a printed card code can be worth. */
export const VOUCHER_POINT_TIERS = [1, 2, 3] as const

export type VoucherTier = (typeof VOUCHER_POINT_TIERS)[number]

/** Largest single points-card print run the admin UI accepts. */
export const MAX_VOUCHER_BATCH_SIZE = 500

/** Largest single physical-card print run the admin UI accepts. */
export const MAX_PHYSICAL_BATCH_SIZE = 200

/** Discount percent a live balance is worth when claimed. */
export function discountPercentForPoints(points: number): number {
  return Math.min(100, Math.max(0, points * DISCOUNT_PERCENT_PER_POINT))
}

/** Discriminator embedded in the QR payload so a scanner rejects foreign codes. */
export const REWARD_QR_TYPE = 'ramyun-reward-v1'

/* -------------------------------------------------------------------------- */
/* Card codes                                                                 */
/* -------------------------------------------------------------------------- */

/** Confusion-free alphabet: digits 2-9 plus A-Z with I, L and O removed. */
export const VOUCHER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export const VOUCHER_CODE_PREFIX = 'RMY'
export const VOUCHER_CODE_BODY_LENGTH = 8

const VOUCHER_CODE_PATTERN = new RegExp(
  `^${VOUCHER_CODE_PREFIX}[${VOUCHER_CODE_ALPHABET}]{${VOUCHER_CODE_BODY_LENGTH}}$`,
)

/** Renders a canonical code for display: `RMY-4K7P-2XQ9`. */
export function formatVoucherCode(code: string): string {
  const body = code.slice(VOUCHER_CODE_PREFIX.length)
  const groups = [VOUCHER_CODE_PREFIX]
  for (let i = 0; i < body.length; i += 4) groups.push(body.slice(i, i + 4))
  return groups.join('-')
}

/**
 * Turns whatever a customer typed off the back of their card into the canonical
 * stored form, or null if it cannot be a code at all.
 */
export function normalizeVoucherCode(raw: string): string | null {
  let value = raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (!value) return null

  if (!value.startsWith(VOUCHER_CODE_PREFIX) && value.length === VOUCHER_CODE_BODY_LENGTH) {
    value = `${VOUCHER_CODE_PREFIX}${value}`
  }

  return VOUCHER_CODE_PATTERN.test(value) ? value : null
}

/** Narrows a number from a request body to a valid card tier. */
export function isVoucherTier(value: unknown): value is VoucherTier {
  return VOUCHER_POINT_TIERS.includes(value as VoucherTier)
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type UserRole = 'customer' | 'admin'

/** Shape of the authenticated user exposed by /api/me. */
export interface CurrentUser {
  id: string
  name: string
  phone: string
  /** Live balance: non-expired awards, capped at MAX_POINT_BALANCE. */
  points: number
  ref_code: string
  role: UserRole
  /** Expiry timestamps of the awards behind the live balance, oldest first. */
  expiries: number[]
  /** Set once the balance reaches the cap - the customer must claim before earning more. */
  capReached: boolean
  /** True once this account has activated a physical TNL card. */
  hasPhysicalCard: boolean
}

/** One live award embedded in the reward QR, so a cashier can spend offline. */
export interface RewardQrAward {
  id: string
  points: number
  /** Epoch ms the award expires. */
  expiresAt: number
}

/** JSON body encoded into the reward QR shown to the cashier. */
export interface RewardQrPayload {
  type: typeof REWARD_QR_TYPE
  userId: string
  issuedAt: number
  /** Display name, carried so the cashier's screen works fully offline. */
  name?: string
  /** Snapshot of the member's current live awards for an offline spend. */
  awards?: RewardQrAward[]
}

export interface RedeemRewardResponse {
  success: true
  userId: string
  customerName: string
  remainingPoints: number
  discountApplied: string
  pointsSpent: number
  /** True when the spend was queued and is waiting on the next sync. */
  pending?: true
}

export interface RedeemVoucherResponse {
  success: true
  code: string
  pointsAdded: number
  newBalance: number
  expiresAt: number
  /** True when the code was queued and points will land after the next sync. */
  pending?: true
}

/** Result of activating a physical TNL card. */
export interface ActivatePhysicalCardResponse {
  success: true
  code: string
  activatedAt: number
  /** True when the activation was queued and is waiting on the next sync. */
  pending?: true
}

/** Live awards formatted for the reward QR. */
export function toRewardQrAwards(
  awards: { id: string; points: number; expires_at: string }[],
): RewardQrAward[] {
  return awards.map((award) => ({ id: award.id, points: award.points, expiresAt: new Date(award.expires_at).getTime() }))
}

export function buildRewardPayload(
  userId: string,
  extras?: { name?: string; awards?: RewardQrAward[] },
): RewardQrPayload {
  return { type: REWARD_QR_TYPE, userId, issuedAt: Date.now(), name: extras?.name, awards: extras?.awards }
}

/**
 * Reads a scanned QR string. Accepts our JSON payload, and degrades to a bare
 * userId so codes printed before this version still redeem.
 */
export function parseRewardPayload(raw: string): RewardQrPayload | null {
  const value = raw.trim()
  if (!value) return null

  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as Partial<RewardQrPayload>
      if (parsed.type === REWARD_QR_TYPE && typeof parsed.userId === 'string' && parsed.userId) {
        const awards = Array.isArray(parsed.awards)
          ? parsed.awards.filter(
              (award): award is RewardQrAward =>
                award != null &&
                typeof award === 'object' &&
                typeof award.id === 'string' &&
                typeof award.points === 'number' &&
                typeof award.expiresAt === 'number',
            )
          : undefined
        return {
          type: REWARD_QR_TYPE,
          userId: parsed.userId,
          issuedAt: parsed.issuedAt ?? Date.now(),
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          awards,
        }
      }
      return null
    } catch {
      return null
    }
  }

  return { type: REWARD_QR_TYPE, userId: value, issuedAt: Date.now() }
}

/* -------------------------------------------------------------------------- */
/* Physical membership cards                                                  */
/* -------------------------------------------------------------------------- */

export const PHYSICAL_CARD_QR_TYPE = 'ramyun-tnlcard-v1'
export const PHYSICAL_CARD_CODE_PREFIX = 'TNL'
export const PHYSICAL_CARD_CODE_BODY_LENGTH = 8

const PHYSICAL_CARD_CODE_PATTERN = new RegExp(
  `^${PHYSICAL_CARD_CODE_PREFIX}[${VOUCHER_CODE_ALPHABET}]{${PHYSICAL_CARD_CODE_BODY_LENGTH}}$`,
)

export function normalizePhysicalCardCode(raw: string): string | null {
  let value = raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (!value) return null

  if (!value.startsWith(PHYSICAL_CARD_CODE_PREFIX) && value.length === PHYSICAL_CARD_CODE_BODY_LENGTH) {
    value = `${PHYSICAL_CARD_CODE_PREFIX}${value}`
  }

  return PHYSICAL_CARD_CODE_PATTERN.test(value) ? value : null
}

/** Renders a physical-card kode for display: `TNL-4K7P-2XQ9`. */
export function formatPhysicalCardCode(code: string): string {
  const body = code.slice(PHYSICAL_CARD_CODE_PREFIX.length)
  const groups = [PHYSICAL_CARD_CODE_PREFIX]
  for (let i = 0; i < body.length; i += 4) groups.push(body.slice(i, i + 4))
  return groups.join('-')
}

export interface PhysicalCardQrPayload {
  type: typeof PHYSICAL_CARD_QR_TYPE
  code: string
}

/** Builds the JSON string encoded in a physical card's activation QR. */
export function buildPhysicalCardQrPayload(code: string): string {
  return JSON.stringify({ type: PHYSICAL_CARD_QR_TYPE, code } satisfies PhysicalCardQrPayload)
}

/**
 * Reads a scanned physical-card QR string. Accepts our JSON payload, and
 * degrades to a bare kode so a hand-typed code works in the same entry point.
 */
export function parsePhysicalCardQrPayload(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as Partial<PhysicalCardQrPayload>
      if (parsed.type === PHYSICAL_CARD_QR_TYPE && typeof parsed.code === 'string') {
        return normalizePhysicalCardCode(parsed.code)
      }
      return null
    } catch {
      return null
    }
  }

  return normalizePhysicalCardCode(value)
}

/** How many more points the customer needs to unlock their first discount. */
export function pointsUntilReward(points: number): number {
  return Math.max(0, REWARD_MIN_POINTS - points)
}

export const CAP_APPRECIATION_MESSAGE =
  'Thanks for being one of our best customers! 🎉 We truly appreciate you. ' +
  'You need to redeem your points before collecting more.'

/* -------------------------------------------------------------------------- */
/* Admin catalog shapes                                                       */
/* -------------------------------------------------------------------------- */

/** Roll-up of one points-card denomination (batches of the same tier merge). */
export interface VoucherBatch {
  /** Representative batch id (the most recent run of this tier). */
  id: string
  points: VoucherTier
  createdAt: string
  total: number
  redeemed: number
}

/** Roll-up of one physical-card print run. */
export interface PhysicalCardBatch {
  id: string
  createdAt: string
  total: number
  activated: number
}

/** One printed points card as returned to the admin UI. */
export interface VoucherCardEntry {
  code: string
  points: number
  /** ISO timestamp once claimed, else null. */
  redeemedAt: string | null
}

/** One printed physical card as returned to the admin UI. */
export interface PhysicalCardEntry {
  code: string
  createdAt: string
  /** ISO timestamp once a customer activates it, else null. */
  activatedAt: string | null
}

export interface CreateVoucherBatchResponse {
  success: true
  batch: VoucherBatch
  cards: VoucherCardEntry[]
}

export interface VoucherBatchesResponse {
  batches: VoucherBatch[]
}

export interface VoucherCardsByPointsResponse {
  points: number
  cards: VoucherCardEntry[]
}

export interface VoucherCardsResponse {
  batchId: string
  cards: VoucherCardEntry[]
}

export interface DeleteVouchersResponse {
  success: true
  deleted: number
}

/** Result of removing every unclaimed card of one voucher denomination. */
export interface DeleteVoucherTierResponse {
  success: true
  deleted: number
}

/** Result of removing every unactivated card of one physical-card batch. */
export interface DeletePhysicalBatchResponse {
  success: true
  deleted: number
}

export interface CreatePhysicalCardsResponse {
  success: true
  batch: PhysicalCardBatch
  cards: PhysicalCardEntry[]
}

export interface PhysicalCardBatchesResponse {
  batches: PhysicalCardBatch[]
}

export interface PhysicalCardBatchCardsResponse {
  batchId: string
  cards: PhysicalCardEntry[]
}