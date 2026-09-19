/**
 * Shared shapes for the offline-first sync protocol.
 *
 * The phone app keeps its own SQLite copy of the data and a write queue; the
 * standalone server (`server/`) is the authoritative source of truth. Ops are
 * pushed with a client-generated `opId` so replaying a push is always safe, and
 * the server pulls role-scoped snapshots so each device only sees what it may.
 *
 * Everything here is framework-agnostic so both the app and the server import
 * it from a single place.
 */

export const SYNC_API_VERSION = 1 as const

export type SyncOpType =
  | 'register_user'
  | 'redeem_voucher'
  | 'activate_physical_card'
  | 'spend_awards'

/** One queued write, created on the device and applied on the server. */
export interface SyncOp {
  /** Client-generated uuid; the server dedupes replays of the same id. */
  opId: string
  type: SyncOpType
  /** Epoch ms of when the customer/admin performed the action. */
  createdAt: number
  /** Which install created the op (cache-busting/audit only). */
  deviceId: string
  payload: SyncOpPayload
}

export type SyncOpPayload =
  | RegisterUserOpPayload
  | RedeemVoucherOpPayload
  | ActivatePhysicalCardOpPayload
  | SpendAwardsOpPayload

export interface RegisterUserOpPayload {
  /** Client-generated uuid, reused by the server so ids match across devices. */
  userId: string
  name: string
  phone: string
  /** Raw PIN - hashed with the server's scrypt scheme when applied. */
  pin: string
  /** Client-suggested referral code; the server re-generates on collision. */
  refCode: string
}

export interface RedeemVoucherOpPayload {
  userId: string
  /** The normalized RMY card code, e.g. `RMY4K7P2XQ9`. */
  code: string
  /** Stable award id minted on the device; the server creates it under this id. */
  awardId: string
  /** Epoch ms the credit was applied; drives the 7-day expiry. */
  awardedAt: number
}

export interface ActivatePhysicalCardOpPayload {
  /** The account linking the printed card. */
  userId: string
  /** The normalized TNL kode, e.g. `TNL4K7P2XQ9`. */
  kode: string
}

export interface SpendAwardsOpPayload {
  /** Cashier's account id, for the audit trail. */
  adminUserId: string
  /** The customer whose balance is being claimed. */
  userId: string
  /** The exact awards in the scanned QR snapshot; server spends these or rejects. */
  awardIds: string[]
  /** Epoch ms the discount was applied at the register. */
  capturedAt: number
}

export type SyncOpResult =
  | {
      opId: string
      ok: true
      /** Authoritative post-op state the device can reconcile against. */
      state?: PushOpState
    }
  | { opId: string; ok: false; reason: string; message: string }

/** Extra server-authoritative information returned with an accepted op. */
export interface PushOpState {
  /** The customer's live balance right after this op (spends only). */
  remainingBalance?: number
  /** Display name of the affected customer. */
  customerName?: string
  /** Session cookie issued for a self-registered user so it can sync next. */
  authCookie?: string
}

/** A single row as it exists on the authoritative server. */
export interface PullUser {
  id: string
  phone: string
  name: string
  points: number
  ref_code: string
  role: string
}

export interface PullAward {
  id: string
  user_id: string
  points: number
  awarded_at: string
  expires_at: string
  source: string
  voucher_code: string | null
  /** When the award was claimed at the register (soft-delete marker). */
  spent_at: string | null
}

export interface PullVoucher {
  code: string
  batch_id: string
  points: number
  created_at: string
  redeemed_by: string | null
  redeemed_at: string | null
}

export interface PullPhysicalCard {
  kode: string
  batch_id: string
  created_at: string
  activated_by: string | null
  activated_at: string | null
}

/** Role-scoped authoritative snapshot returned by GET /api/sync/pull. */
export interface SyncSnapshot {
  version: typeof SYNC_API_VERSION
  /** Epoch ms server time - the client stores this as its next sync marker. */
  serverTime: number
  users: PullUser[]
  awards: PullAward[]
  vouchers: PullVoucher[]
  physicalCards: PullPhysicalCard[]
}

export interface SyncPushRequest {
  ops: SyncOp[]
}

export interface SyncPushResponse {
  /** One result per op, in the same order as the request. */
  results: SyncOpResult[]
  /** Epoch ms server time - the client can pull immediately with this marker. */
  serverTime: number
}