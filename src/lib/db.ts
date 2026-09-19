import * as Crypto from 'expo-crypto'
import * as SQLite from 'expo-sqlite'
import {
  MAX_POINT_BALANCE,
  PHYSICAL_CARD_CODE_BODY_LENGTH,
  PHYSICAL_CARD_CODE_PREFIX,
  POINTS_EXPIRY_DAYS,
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_BODY_LENGTH,
  VOUCHER_CODE_PREFIX,
  type CurrentUser,
  type PhysicalCardBatch,
  type UserRole,
  type VoucherBatch,
  type VoucherTier,
} from './loyalty'
import { hashPin } from './pin'
import { SYNC_API_VERSION, type SyncOp, type SyncSnapshot } from './syncTypes'

/**
 * On-device cache + write queue for the offline-first build.
 *
 * The tables mirror `server/src/db.ts`, plus the sync working set: the queued
 * write journal (`pending_ops`), the duplicate-scan guard (`spend_reservations`),
 * the disconnect notices (`notices`) and the last-sync marker (`sync_meta`).
 *
 * Points live as individual "awards", each carrying the epoch ms it expires, so
 * the live balance is the sum of the non-expired awards and 7-day expiry needs
 * no cron job. `users.points` stays in sync as a display cache only.
 *
 * Writes that cannot reach the authoritative server are queued as sync ops. Ops
 * carry client-generated ids and are replayed idempotently; provisional rows are
 * flagged with a `pending_op` id so a rejected push can be rolled back. The
 * device's copy of the rows is swapped wholesale for the server's pull snapshot.
 */

const DB_NAME = 'tnl.db'
const DB_VERSION = 2

/** Mirrors a row of `public.users`. `points` is a cache of the live balance. */
export interface UserRow {
  id: string
  phone: string
  name: string
  points: number
  pin_hash: string
  ref_code: string
  role: UserRole
  /** Sync op id while this row is a provisional off-server effect. */
  pending_op: string | null
}

/** One grant of points, e.g. from a claimed card code. */
export interface PointAwardRow {
  id: string
  user_id: string
  /** 0 means the award never expires. */
  points: number
  awarded_at: string
  /** ISO timestamp after which the award stops counting toward the balance. */
  expires_at: string
  /** Where it came from, for the audit trail. */
  source: 'voucher' | 'manual'
  /** Card code that produced it, when source === 'voucher'. */
  voucher_code: string | null
  /** Soft-delete marker: when a cashier spent this award at the counter. */
  spent_at: string | null
  /** Sync op id while this award is a provisional off-server effect. */
  pending_op: string | null
}

/** Mirrors a row of `public.vouchers`: one row per printed card. */
export interface VoucherRow {
  code: string
  batch_id: string
  points: number
  created_at: string
  /** null while the card is still unused. */
  redeemed_by: string | null
  redeemed_at: string | null
  /** Sync op id while this row is a provisional off-server effect. */
  pending_op: string | null
}

/** Mirrors a row of `public.physical_cards`. */
export interface PhysicalCardRow {
  kode: string
  batch_id: string
  created_at: string
  /** null while the printed card is still unactivated/unsold. */
  activated_by: string | null
  activated_at: string | null
  /** Sync op id while this row is a provisional off-server effect. */
  pending_op: string | null
}

/**
 * One cashier spend that has been scanned but not yet confirmed by the server.
 * The reserved award ids keep a second device from spending the same points
 * until the push result clears the reservation.
 */
export interface SpendReservationRow {
  op_id: string
  user_id: string
  /** JSON array of the award ids being spent. */
  award_ids: string
  points: number
  created_at: string
}

/** A user-visible notice about background sync (rejected or failed pushes). */
export interface NoticeRow {
  id: string
  title: string
  message: string
  kind: 'rejected' | 'error' | 'info'
  created_at: string
}

export type RedeemResult =
  | {
      ok: true
      user: { id: string; name: string }
      remainingPoints: number
      pointsSpent: number
    }
  | { ok: false; reason: 'user_not_found' }
  | { ok: false; reason: 'insufficient_points'; points: number }

export type CreateUserResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'phone_taken' }

export type RedeemVoucherResult =
  | { ok: true; code: string; pointsAdded: number; newBalance: number; expiresAt: number }
  | { ok: false; reason: 'unknown_code' | 'user_not_found' }
  | { ok: false; reason: 'already_redeemed' }
  | { ok: false; reason: 'balance_cap'; cap: number; points: number }

/** Minimal query surface shared by the database and a transaction. */
interface SqlRunner {
  getAllAsync<T = unknown>(source: string, params: SQLite.SQLiteBindParams): Promise<T[]>
  getFirstAsync<T = unknown>(source: string, params: SQLite.SQLiteBindParams): Promise<T | null>
  runAsync(source: string, params: SQLite.SQLiteBindParams): Promise<SQLite.SQLiteRunResult>
}

/* -------------------------------------------------------------------------- */
/* Randomness (node:crypto replacements)                                      */
/* -------------------------------------------------------------------------- */

function randomInt(min: number, max: number): number {
  const bytes = Crypto.getRandomBytes(4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return min + (view.getUint32(0) % (max - min))
}

/** Fresh random code, retrying if it happens to match one already in `taken`. */
function generateVoucherCode(taken: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let body = ''
    for (let i = 0; i < VOUCHER_CODE_BODY_LENGTH; i += 1) {
      body += VOUCHER_CODE_ALPHABET[randomInt(0, VOUCHER_CODE_ALPHABET.length)]
    }
    const code = `${VOUCHER_CODE_PREFIX}${body}`
    if (!taken.has(code)) return code
  }
  throw new Error('Could not generate a unique card code')
}

/** Fresh random physical-card kode, retrying on a collision with `taken`. */
function generatePhysicalCardCode(taken: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let body = ''
    for (let i = 0; i < PHYSICAL_CARD_CODE_BODY_LENGTH; i += 1) {
      body += VOUCHER_CODE_ALPHABET[randomInt(0, VOUCHER_CODE_ALPHABET.length)]
    }
    const kode = `${PHYSICAL_CARD_CODE_PREFIX}${body}`
    if (!taken.has(kode)) return kode
  }
  throw new Error('Could not generate a unique card kode')
}

/* -------------------------------------------------------------------------- */
/* Schema + seeding                                                           */
/* -------------------------------------------------------------------------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  pin_hash TEXT NOT NULL,
  ref_code TEXT NOT NULL,
  role TEXT NOT NULL,
  pending_op TEXT
);
CREATE TABLE IF NOT EXISTS awards (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  awarded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source TEXT NOT NULL,
  voucher_code TEXT,
  spent_at TEXT,
  pending_op TEXT
);
CREATE TABLE IF NOT EXISTS vouchers (
  code TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  redeemed_by TEXT,
  redeemed_at TEXT,
  pending_op TEXT
);
CREATE TABLE IF NOT EXISTS physical_cards (
  kode TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_by TEXT,
  activated_at TEXT,
  pending_op TEXT
);
CREATE TABLE IF NOT EXISTS pending_ops (
  op_id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  device_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend_reservations (
  op_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  award_ids TEXT NOT NULL,
  points INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`

/** ISO timestamp POINTS_EXPIRY_DAYS from `from` (defaults to now). */
function awardExpiry(from: number = Date.now()): string {
  return new Date(from + POINTS_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Short, readable referral code derived from the name, e.g. `KIM4821`.
 * Retries on collision and falls back to a random code if all attempts clash.
 */
function generateRefCode(name: string, taken: Set<string>): string {
  const base =
    name
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .slice(0, 4) || 'RAMYUN'

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = `${base}${randomInt(1000, 10000)}`
    if (!taken.has(code)) return code
  }
  return `R${Crypto.randomUUID().replace(/\D/g, '').slice(0, 7).padEnd(7, '0')}`
}

async function seed(exec: SqlRunner): Promise<void> {
  const adminPin = await hashPin('0000')
  const customerPin = await hashPin('1234')
  const now = Date.now()

  await exec.runAsync(
    `INSERT INTO users (id, phone, name, points, pin_hash, ref_code, role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [Crypto.randomUUID(), '09518050546', 'Ramyun Admin', 0, adminPin, 'ADMIN', 'admin'],
  )

  // Seeded customers start above zero so the reward flow is demoable.
  const insertCustomer = async (phone: string, name: string, points: number, refCode: string) => {
    const id = Crypto.randomUUID()
    await exec.runAsync(
      `INSERT INTO users (id, phone, name, points, pin_hash, ref_code, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, phone, name, points, customerPin, refCode, 'customer'],
    )
    if (points > 0) {
      await exec.runAsync(
        `INSERT INTO awards (id, user_id, points, awarded_at, expires_at, source, voucher_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [Crypto.randomUUID(), id, points, new Date(now).toISOString(), awardExpiry(now), 'manual', null],
      )
    }
  }
  await insertCustomer('01011111111', 'Kim Minji', 7, 'MINJI7')
  await insertCustomer('01022222222', 'Lee Junho', 3, 'JUNHO3')
}

/* -------------------------------------------------------------------------- */
/* Database open                                                              */
/* -------------------------------------------------------------------------- */

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null

/** Brings a v1 (single-device) database up to v2 by adding the sync columns. */
async function migrateV1(db: SQLite.SQLiteDatabase): Promise<void> {
  const adds: [string, string][] = [
    ['users', 'pending_op TEXT'],
    ['awards', 'spent_at TEXT'],
    ['awards', 'pending_op TEXT'],
    ['vouchers', 'pending_op TEXT'],
    ['physical_cards', 'pending_op TEXT'],
  ]
  for (const [table, column] of adds) {
    const name = column.split(' ')[0]
    const info = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`, [])
    if (!info.some((candidate) => candidate.name === name)) {
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column}`)
    }
  }
}

async function openAndInit(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME)
  await db.execAsync('PRAGMA journal_mode = WAL;')

  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version')
  const version = versionRow?.user_version ?? 0
  if (version >= DB_VERSION) return db

  await db.execAsync(SCHEMA)
  if (version > 0) await migrateV1(db)
  else await seed(db)
  await db.execAsync(`PRAGMA user_version = ${DB_VERSION}`)
  return db
}

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = openAndInit()
  return dbPromise
}

/* -------------------------------------------------------------------------- */
/* Award expiry                                                               */
/* -------------------------------------------------------------------------- */

/** Non-expired awards for one user, oldest first. */
async function liveAwards(runner: SqlRunner, userId: string): Promise<PointAwardRow[]> {
  const now = Date.now()
  const awards = await runner.getAllAsync<PointAwardRow>(
    'SELECT * FROM awards WHERE user_id = ? ORDER BY awarded_at ASC',
    [userId],
  )
  return awards.filter((award) => award.spent_at == null && new Date(award.expires_at).getTime() > now)
}

/**
 * Everything the client needs about a user's live points: the capped balance,
 * when each award expires (soonest last), and whether the cap is reached.
 */
export async function getLivePointsInfo(userId: string): Promise<{
  points: number
  expiries: number[]
  capReached: boolean
}> {
  const db = await getDb()
  const awards = await liveAwards(db, userId)
  const total = awards.reduce((sum, award) => sum + award.points, 0)
  return {
    points: Math.min(MAX_POINT_BALANCE, total),
    expiries: awards.map((award) => new Date(award.expires_at).getTime()).sort((a, b) => a - b),
    capReached: total >= MAX_POINT_BALANCE,
  }
}

/**
 * True once the customer has activated a physical TNL card, so the card page
 * can skip the activation step. The card's activated_by stamp is the logical
 * link between the printed card and the account.
 */
export async function hasActivatedPhysicalCard(userId: string): Promise<boolean> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ one: number }>(
    'SELECT 1 AS one FROM physical_cards WHERE activated_by = ? LIMIT 1',
    [userId],
  )
  return row != null
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getUserById(id: string): Promise<UserRow | null> {
  const db = await getDb()
  return db.getFirstAsync<UserRow>('SELECT * FROM users WHERE id = ?', [id])
}

export async function getUserByPhone(phone: string): Promise<UserRow | null> {
  const db = await getDb()
  return db.getFirstAsync<UserRow>('SELECT * FROM users WHERE phone = ?', [phone])
}

/** Total number of registered customer accounts (admins excluded). */
export async function countCustomers(): Promise<number> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE role = ?', [
    'customer',
  ])
  return row?.n ?? 0
}

/**
 * Registers a new customer starting at 0 points. Returns a discriminated result
 * so the caller can map a duplicate phone number to a 409.
 */
export async function createCustomer(input: {
  name: string
  phone: string
  pin: string
}): Promise<CreateUserResult> {
  const db = await getDb()
  const pinHash = await hashPin(input.pin)

  const users = await db.getAllAsync<UserRow>('SELECT * FROM users', [])
  if (users.some((user) => user.phone === input.phone)) {
    return { ok: false as const, reason: 'phone_taken' as const }
  }

  const user: UserRow = {
    id: Crypto.randomUUID(),
    phone: input.phone,
    name: input.name,
    points: 0,
    pin_hash: pinHash,
    ref_code: generateRefCode(input.name, new Set(users.map((candidate) => candidate.ref_code))),
    role: 'customer',
    pending_op: null,
  }

  await db.runAsync(
    `INSERT INTO users (id, phone, name, points, pin_hash, ref_code, role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.phone, user.name, user.points, user.pin_hash, user.ref_code, user.role],
  )
  return { ok: true as const, user: { ...user } }
}

/**
 * Claims a customer's whole live balance as a discount: every non-expired
 * award is spent at once, so after the scan the balance is zero and collecting
 * can start again. Runs in a transaction so scans cannot race.
 */
export async function redeemRewardPoints(
  userId: string,
  minPoints: number,
): Promise<RedeemResult> {
  const db = await getDb()
  let outcome: RedeemResult = { ok: false as const, reason: 'user_not_found' as const }

  await db.withExclusiveTransactionAsync(async (txn) => {
    const user = await txn.getFirstAsync<UserRow>('SELECT * FROM users WHERE id = ?', [userId])
    if (!user) return

    const awards = await liveAwards(txn, userId)
    const liveTotal = awards.reduce((total, award) => total + award.points, 0)
    if (liveTotal < minPoints) {
      outcome = { ok: false as const, reason: 'insufficient_points' as const, points: liveTotal }
      return
    }

    const spent = liveTotal
    for (const award of awards) {
      await txn.runAsync('DELETE FROM awards WHERE id = ?', [award.id])
    }
    await txn.runAsync('UPDATE users SET points = 0 WHERE id = ?', [userId])

    outcome = {
      ok: true as const,
      user: { id: user.id, name: user.name },
      remainingPoints: 0,
      pointsSpent: spent,
    }
  })

  return outcome
}

/**
 * Resolves a physical-card kode to the account that activated it, so the
 * cashier can scan the printed card instead of the customer's phone.
 */
export async function resolvePhysicalCardOwner(
  kode: string,
): Promise<{ ok: true; userId: string } | { ok: false; reason: 'unknown_kode' | 'not_activated' }> {
  const db = await getDb()
  const card = await db.getFirstAsync<PhysicalCardRow>(
    'SELECT * FROM physical_cards WHERE kode = ?',
    [kode],
  )
  if (!card) return { ok: false, reason: 'unknown_kode' }
  if (!card.activated_by) return { ok: false, reason: 'not_activated' }
  return { ok: true, userId: card.activated_by }
}

/**
 * Activates a physical card for a customer: one transaction-critical update
 * guarded by `activated_at is null`, so two accounts scanning the same printed
 * QR at the same instant can never both win.
 */
export async function activatePhysicalCard(input: {
  kode: string
  userId: string
}): Promise<
  | { ok: true; kode: string; activatedAt: string }
  | { ok: false; reason: 'unknown_kode' | 'user_not_found' | 'already_activated' }
> {
  const db = await getDb()
  let outcome:
    | { ok: true; kode: string; activatedAt: string }
    | { ok: false; reason: 'unknown_kode' | 'user_not_found' | 'already_activated' } = {
    ok: false,
    reason: 'user_not_found',
  }

  await db.withExclusiveTransactionAsync(async (txn) => {
    const user = await txn.getFirstAsync<UserRow>('SELECT * FROM users WHERE id = ?', [input.userId])
    if (!user) return

    const card = await txn.getFirstAsync<PhysicalCardRow>(
      'SELECT * FROM physical_cards WHERE kode = ?',
      [input.kode],
    )
    if (!card) {
      outcome = { ok: false, reason: 'unknown_kode' }
      return
    }
    if (card.activated_at) {
      outcome = { ok: false, reason: 'already_activated' }
      return
    }

    const activatedAt = new Date().toISOString()
    await txn.runAsync(
      'UPDATE physical_cards SET activated_by = ?, activated_at = ? WHERE kode = ?',
      [input.userId, activatedAt, input.kode],
    )
    outcome = { ok: true as const, kode: card.kode, activatedAt }
  })

  return outcome
}

/**
 * Claims a card for a customer: marks the card used, records an expiring point
 * award, and refreshes the cached balance. All writes land in one transaction
 * so a code submitted twice at the same instant can only ever pay out once,
 * and a claim that would push the balance past the cap is refused with the
 * card left unused, so no value is ever lost.
 */
export async function redeemVoucher(input: {
  code: string
  userId: string
}): Promise<RedeemVoucherResult> {
  const db = await getDb()
  let outcome: RedeemVoucherResult = { ok: false as const, reason: 'user_not_found' as const }

  await db.withExclusiveTransactionAsync(async (txn) => {
    const user = await txn.getFirstAsync<UserRow>('SELECT * FROM users WHERE id = ?', [input.userId])
    if (!user) return

    const voucher = await txn.getFirstAsync<VoucherRow>('SELECT * FROM vouchers WHERE code = ?', [
      input.code,
    ])
    if (!voucher) {
      outcome = { ok: false as const, reason: 'unknown_code' as const }
      return
    }
    // `redeemed_at` is the spent marker; `redeemed_by` is only an audit trail.
    if (voucher.redeemed_at) {
      outcome = { ok: false as const, reason: 'already_redeemed' as const }
      return
    }

    const awards = await liveAwards(txn, input.userId)
    const liveTotal = awards.reduce((total, award) => total + award.points, 0)
    if (liveTotal + voucher.points > MAX_POINT_BALANCE) {
      outcome = {
        ok: false as const,
        reason: 'balance_cap' as const,
        cap: MAX_POINT_BALANCE,
        points: liveTotal,
      }
      return
    }

    const now = Date.now()
    await txn.runAsync(
      `INSERT INTO awards (id, user_id, points, awarded_at, expires_at, source, voucher_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [Crypto.randomUUID(), user.id, voucher.points, new Date(now).toISOString(), awardExpiry(now), 'voucher', voucher.code],
    )
    await txn.runAsync('UPDATE vouchers SET redeemed_by = ?, redeemed_at = ? WHERE code = ?', [
      user.id,
      new Date(now).toISOString(),
      voucher.code,
    ])
    const newBalance = Math.min(MAX_POINT_BALANCE, liveTotal + voucher.points)
    await txn.runAsync('UPDATE users SET points = ? WHERE id = ?', [newBalance, user.id])

    outcome = {
      ok: true as const,
      code: voucher.code,
      pointsAdded: voucher.points,
      newBalance,
      expiresAt: new Date(awardExpiry(now)).getTime(),
    }
  })

  return outcome
}

/* -------------------------------------------------------------------------- */
/* Admin catalog management                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Points-card roll-up, merged by denomination and newest first. One entry per
 * tier shows how much of the printed pool has come back, e.g. 4 / 10 claimed.
 */
export async function listVoucherBatches(limit = 20): Promise<VoucherBatch[]> {
  const db = await getDb()
  const vouchers = await db.getAllAsync<VoucherRow>('SELECT * FROM vouchers', [])
  const groups = new Map<number, VoucherBatch>()
  const representatives = new Map<number, { id: string; createdAt: string }>()

  for (const voucher of vouchers) {
    const group = groups.get(voucher.points) ?? {
      id: '',
      points: voucher.points as VoucherTier,
      createdAt: '',
      total: 0,
      redeemed: 0,
    }
    group.total += 1
    if (voucher.redeemed_at) group.redeemed += 1
    if (group.createdAt === '' || voucher.created_at > group.createdAt) {
      group.createdAt = voucher.created_at
    }
    const rep = representatives.get(voucher.points)
    if (!rep || voucher.created_at > rep.createdAt) {
      representatives.set(voucher.points, { id: voucher.batch_id, createdAt: voucher.created_at })
    }
    groups.set(voucher.points, group)
  }

  return [...groups.values()]
    .map((group) => ({ ...group, id: representatives.get(group.points)?.id ?? '' }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
}

/** The cards of one batch, for printing or reprinting a sheet. */
export async function listVoucherCards(batchId: string): Promise<VoucherRow[]> {
  const db = await getDb()
  return db.getAllAsync<VoucherRow>(
    'SELECT * FROM vouchers WHERE batch_id = ? ORDER BY code ASC',
    [batchId],
  )
}

/** Every card of one points denomination, across merged batches, newest first. */
export async function listVoucherCardsByPoints(points: number): Promise<VoucherRow[]> {
  const db = await getDb()
  return db.getAllAsync<VoucherRow>(
    'SELECT * FROM vouchers WHERE points = ? ORDER BY created_at DESC',
    [points],
  )
}

/**
 * Prints a batch of single-use points cards.
 *
 * Codes are minted here and never accepted from a client, and the tier is stored
 * on the card itself - so redemption always credits the value that was actually
 * printed. A new run of the same denomination joins the most recent batch.
 */
export async function createVoucherBatch(input: {
  points: VoucherTier
  quantity: number
}): Promise<{ batchId: string; cards: VoucherRow[] }> {
  const db = await getDb()
  const createdAt = new Date().toISOString()

  const existing = await db.getAllAsync<VoucherRow>('SELECT * FROM vouchers', [])
  const latest = existing
    .filter((voucher) => voucher.points === input.points)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  const batchId = latest?.batch_id ?? Crypto.randomUUID()
  const taken = new Set(existing.map((voucher) => voucher.code))
  const cards: VoucherRow[] = []

  for (let i = 0; i < input.quantity; i += 1) {
    const code = generateVoucherCode(taken)
    taken.add(code)
    const card: VoucherRow = {
      code,
      batch_id: batchId,
      points: input.points,
      created_at: createdAt,
      redeemed_by: null,
      redeemed_at: null,
      pending_op: null,
    }
    cards.push(card)
    await db.runAsync(
      `INSERT INTO vouchers (code, batch_id, points, created_at, redeemed_by, redeemed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [card.code, card.batch_id, card.points, card.created_at, null, null],
    )
  }
  return { batchId, cards }
}

/**
 * Permanently deletes claimed cards only, so used-up runs do not clog the admin
 * list. Unclaimed codes in the request are ignored, no matter what is listed.
 */
export async function deleteVouchers(codes: string[]): Promise<{ deleted: number }> {
  if (codes.length === 0) return { deleted: 0 }
  const db = await getDb()

  let deleted = 0
  for (const code of codes) {
    const result = await db.runAsync(
      'DELETE FROM vouchers WHERE code = ? AND redeemed_at IS NOT NULL',
      [code],
    )
    deleted += result.changes
  }
  return { deleted }
}

/** Roll-up of one physical-card print run, newest first. */
export async function listPhysicalCardBatches(): Promise<PhysicalCardBatch[]> {
  const db = await getDb()
  const cards = await db.getAllAsync<PhysicalCardRow>('SELECT * FROM physical_cards', [])
  const groups = new Map<string, PhysicalCardBatch>()
  for (const card of cards) {
    const group = groups.get(card.batch_id) ?? {
      id: card.batch_id,
      createdAt: card.created_at,
      total: 0,
      activated: 0,
    }
    group.total += 1
    if (card.activated_at) group.activated += 1
    if (card.created_at > group.createdAt) group.createdAt = card.created_at
    groups.set(card.batch_id, group)
  }
  return [...groups.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Every card of one physical-card print run, for previewing or re-exporting. */
export async function listPhysicalCardsByBatch(batchId: string): Promise<PhysicalCardRow[]> {
  const db = await getDb()
  return db.getAllAsync<PhysicalCardRow>(
    'SELECT * FROM physical_cards WHERE batch_id = ? ORDER BY kode ASC',
    [batchId],
  )
}

/**
 * Prints a batch of blank physical TNL cards: a batch id plus fresh kodes.
 * Nothing identifies a customer here - the cards are sold blank, and the buyer
 * activates theirs by scanning the printed QR from their own account.
 */
export async function createPhysicalCardBatch(quantity: number): Promise<{
  batchId: string
  cards: PhysicalCardRow[]
}> {
  const db = await getDb()
  const createdAt = new Date().toISOString()
  const existing = await db.getAllAsync<PhysicalCardRow>('SELECT * FROM physical_cards', [])
  const taken = new Set(existing.map((card) => card.kode))
  const batchId = Crypto.randomUUID()
  const batch: PhysicalCardRow[] = []

  for (let i = 0; i < quantity; i += 1) {
    const kode = generatePhysicalCardCode(taken)
    taken.add(kode)
    const card: PhysicalCardRow = {
      kode,
      batch_id: batchId,
      created_at: createdAt,
      activated_by: null,
      activated_at: null,
      pending_op: null,
    }
    batch.push(card)
    await db.runAsync(
      `INSERT INTO physical_cards (kode, batch_id, created_at, activated_by, activated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [card.kode, card.batch_id, card.created_at, null, null],
    )
  }
  return { batchId, cards: batch }
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                              */
/* -------------------------------------------------------------------------- */

/** Projects a stored user row into the client-safe shape, with live points. */
export async function toCurrentUser(user: UserRow): Promise<CurrentUser> {
  const [info, hasPhysicalCard] = await Promise.all([
    getLivePointsInfo(user.id),
    hasActivatedPhysicalCard(user.id),
  ])
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    points: info.points,
    expiries: info.expiries,
    capReached: info.capReached,
    hasPhysicalCard,
    ref_code: user.ref_code,
    role: user.role,
  }
}

/* -------------------------------------------------------------------------- */
/* Sync (offline-first)                                                       */
/* -------------------------------------------------------------------------- */

/** All live awards for a user, as the QR snapshot should describe them. */
export async function getLiveAwards(userId: string): Promise<PointAwardRow[]> {
  const db = await getDb()
  const awards = await db.getAllAsync<PointAwardRow>(
    'SELECT * FROM awards WHERE user_id = ? ORDER BY awarded_at ASC',
    [userId],
  )
  const now = Date.now()
  return awards.filter((award) => award.spent_at == null && new Date(award.expires_at).getTime() > now)
}

/**
 * Upserts a server-provided user row without clobbering the local PIN hash or
 * a pending registration. Used after a direct (online) login/register and by
 * the snapshot merge.
 */
export async function upsertUser(input: {
  id: string
  phone: string
  name: string
  points: number
  ref_code: string
  role: UserRole
  pin_hash?: string
  pending_op?: string | null
}): Promise<UserRow> {
  const db = await getDb()
  const existing = await db.getFirstAsync<UserRow>('SELECT * FROM users WHERE phone = ?', [input.phone])
  if (existing) {
    await db.runAsync(
      'UPDATE users SET id = ?, name = ?, points = ?, ref_code = ?, role = ?, pin_hash = ? WHERE id = ?',
      [input.id, input.name, input.points, input.ref_code, input.role, input.pin_hash ?? existing.pin_hash, existing.id],
    )
    return (await db.getFirstAsync<UserRow>('SELECT * FROM users WHERE phone = ?', [input.phone])) as UserRow
  }
  await db.runAsync(
    `INSERT INTO users (id, phone, name, points, pin_hash, ref_code, role, pending_op)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.phone, input.name, input.points, input.pin_hash ?? '', input.ref_code, input.role, input.pending_op ?? null],
  )
  return (await db.getFirstAsync<UserRow>('SELECT * FROM users WHERE phone = ?', [input.phone])) as UserRow
}

/* ------------------------------- Write queue ------------------------------ */

/** Queues one write op for the next push (idempotent by `opId`). */
export async function insertPendingOp(op: SyncOp): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `INSERT OR IGNORE INTO pending_ops (op_id, type, payload, created_at, device_id)
     VALUES (?, ?, ?, ?, ?)`,
    [op.opId, op.type, JSON.stringify(op.payload), new Date(op.createdAt).toISOString(), op.deviceId],
  )
}

/** All queued ops, oldest first (the server applies them in this order). */
export async function listPendingOps(): Promise<SyncOp[]> {
  const db = await getDb()
  const rows = await db.getAllAsync<{ op_id: string; type: string; payload: string; created_at: string; device_id: string }>(
    'SELECT * FROM pending_ops ORDER BY created_at ASC',
    [],
  )
  return rows.map((row) => ({
    opId: row.op_id,
    type: row.type as SyncOp['type'],
    createdAt: new Date(row.created_at).getTime(),
    deviceId: row.device_id,
    payload: JSON.parse(row.payload),
  }))
}

/** Drops a queued op once the server has finalised it. */
export async function deletePendingOp(opId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM pending_ops WHERE op_id = ?', [opId])
}

export async function countPendingOps(): Promise<number> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM pending_ops', [])
  return row?.n ?? 0
}

/* ---------------------------- Provisional writes -------------------------- */

/**
 * Registers a customer offline: a local row flagged `pending_op` plus a queued
 * `register_user` op, so a rejected push (phone already taken) rolls back cleanly.
 */
export async function createCustomerProvisional(input: {
  name: string
  phone: string
  pin: string
  opId: string
  deviceId: string
}): Promise<{ ok: true; user: UserRow; op: SyncOp } | { ok: false; reason: 'phone_taken' }> {
  const db = await getDb()
  const users = await db.getAllAsync<UserRow>('SELECT * FROM users', [])
  if (users.some((user) => user.phone === input.phone)) return { ok: false, reason: 'phone_taken' }

  const pending = await listPendingOps()
  if (pending.some((op) => op.type === 'register_user' && op.payload && (op.payload as { phone?: string }).phone === input.phone)) {
    return { ok: false, reason: 'phone_taken' }
  }

  const userId = Crypto.randomUUID()
  const refCode = generateRefCode(input.name, new Set(users.map((candidate) => candidate.ref_code)))
  const user: UserRow = {
    id: userId,
    phone: input.phone,
    name: input.name,
    points: 0,
    pin_hash: await hashPin(input.pin),
    ref_code: refCode,
    role: 'customer',
    pending_op: input.opId,
  }
  await db.runAsync(
    `INSERT INTO users (id, phone, name, points, pin_hash, ref_code, role, pending_op)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.phone, user.name, user.points, user.pin_hash, user.ref_code, user.role, user.pending_op],
  )
  const op: SyncOp = {
    opId: input.opId,
    type: 'register_user',
    createdAt: Date.now(),
    deviceId: input.deviceId,
    payload: { userId, name: input.name, phone: input.phone, pin: input.pin, refCode },
  }
  return { ok: true, user, op }
}

/** Clears the pending flag on a user once its register op is accepted. */
export async function clearUserPendingByOp(opId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('UPDATE users SET pending_op = NULL WHERE pending_op = ?', [opId])
}

/** Rolls back a rejected offline registration (user + any awards). */
export async function dropUserById(userId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM awards WHERE user_id = ?', [userId])
  await db.runAsync('DELETE FROM users WHERE id = ?', [userId])
}

/**
 * Activates a physical card offline: a provisional card row (flagging the op)
 * plus a queued `activate_physical_card` op. An already-activated or pending
 * local row is refused so a duplicate scan cannot double-queue.
 */
export async function activatePhysicalCardProvisional(input: {
  kode: string
  userId: string
  opId: string
}): Promise<{ ok: true; kode: string } | { ok: false; reason: 'unknown_kode' | 'user_not_found' | 'already_activated' }> {
  const db = await getDb()
  const user = await db.getFirstAsync<UserRow>('SELECT * FROM users WHERE id = ?', [input.userId])
  if (!user) return { ok: false, reason: 'user_not_found' }

  const card = await db.getFirstAsync<PhysicalCardRow>('SELECT * FROM physical_cards WHERE kode = ?', [input.kode])
  if (card) {
    if (card.activated_at != null || card.pending_op != null) return { ok: false, reason: 'already_activated' }
  }

  const now = new Date().toISOString()
  if (card) {
    await db.runAsync(
      'UPDATE physical_cards SET activated_by = ?, activated_at = ?, pending_op = ? WHERE kode = ?',
      [input.userId, now, input.opId, input.kode],
    )
  } else {
    await db.runAsync(
      `INSERT INTO physical_cards (kode, batch_id, created_at, activated_by, activated_at, pending_op)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.kode, Crypto.randomUUID(), now, input.userId, now, input.opId],
    )
  }
  return { ok: true, kode: input.kode }
}

/** Finalises a provisional card once its activation op is accepted. */
export async function clearPhysicalCardPendingByOp(opId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('UPDATE physical_cards SET pending_op = NULL WHERE pending_op = ?', [opId])
}

/** Rolls back a rejected offline activation. */
export async function deletePhysicalCardByOp(opId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM physical_cards WHERE pending_op = ?', [opId])
}

/* --------------------------- Spend reservations --------------------------- */

/** Records a cashier scan so another offline device cannot spend it again. */
export async function addSpendReservation(input: {
  opId: string
  userId: string
  awardIds: string[]
  points: number
}): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `INSERT OR IGNORE INTO spend_reservations (op_id, user_id, award_ids, points, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.opId, input.userId, JSON.stringify(input.awardIds), input.points, new Date().toISOString()],
  )
}

export async function removeSpendReservation(opId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM spend_reservations WHERE op_id = ?', [opId])
}

/** Award ids currently reserved by an unconfirmed offline spend. */
export async function listReservedAwardIds(): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db.getAllAsync<SpendReservationRow>('SELECT * FROM spend_reservations', [])
  const ids = new Set<string>()
  for (const row of rows) {
    for (const id of JSON.parse(row.award_ids) as string[]) ids.add(id)
  }
  return ids
}

/** Removes the spent awards only once the server confirms the spend. */
export async function deleteAwardsByIds(awardIds: string[]): Promise<void> {
  if (awardIds.length === 0) return
  const db = await getDb()
  await db.runAsync(
    `DELETE FROM awards WHERE id IN (${awardIds.map(() => '?').join(',')})`,
    awardIds,
  )
}

/** Rebuilds `users.points` from the non-expired, non-spent awards. */
export async function recomputeUserPoints(userId: string): Promise<void> {
  const db = await getDb()
  const awards = await liveAwards(db, userId)
  const points = Math.min(MAX_POINT_BALANCE, awards.reduce((sum, award) => sum + award.points, 0))
  await db.runAsync('UPDATE users SET points = ? WHERE id = ?', [points, userId])
}

/* --------------------------------- Notices -------------------------------- */

export async function addNotice(input: {
  title: string
  message: string
  kind: NoticeRow['kind']
}): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `INSERT INTO notices (id, title, message, kind, created_at) VALUES (?, ?, ?, ?, ?)`,
    [Crypto.randomUUID(), input.title, input.message, input.kind, new Date().toISOString()],
  )
}

export async function listNotices(): Promise<NoticeRow[]> {
  const db = await getDb()
  return db.getAllAsync<NoticeRow>('SELECT * FROM notices ORDER BY created_at DESC', [])
}

export async function clearNotices(): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM notices', [])
}

/* -------------------------------- sync_meta ------------------------------- */

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key])
  return row?.value ?? null
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, value])
}

/* ----------------------------- Snapshot merge ----------------------------- */

/**
 * Swaps the cached copy of every table for the authoritative pull snapshot.
 * Provisional rows (flagged `pending_op`) survive; everything else mirrors the
 * server. Runs atomically so a partial merge can never be observed.
 */
export async function applySyncSnapshot(snapshot: SyncSnapshot): Promise<void> {
  if (snapshot.version !== SYNC_API_VERSION) {
    throw new Error('Unsupported sync snapshot version')
  }
  const db = await getDb()

  await db.withExclusiveTransactionAsync(async (txn) => {
    /* Users: upsert pulled (keeps local PIN hash), keep pending, drop the rest. */
    const pendingUsers = await txn.getAllAsync<UserRow>(
      'SELECT * FROM users WHERE pending_op IS NOT NULL',
      [],
    )
    const pendingPhones = new Set(pendingUsers.map((user) => user.phone))
    const snapshotPhones = new Set(snapshot.users.map((user) => user.phone))

    for (const pulled of snapshot.users) {
      const existing = await txn.getFirstAsync<UserRow>('SELECT * FROM users WHERE phone = ?', [pulled.phone])
      if (existing && existing.pending_op != null) continue
      if (existing) {
        await txn.runAsync(
          'UPDATE users SET id = ?, name = ?, points = ?, ref_code = ?, role = ? WHERE id = ?',
          [pulled.id, pulled.name, pulled.points, pulled.ref_code, pulled.role, existing.id],
        )
      } else {
        await txn.runAsync(
          `INSERT INTO users (id, phone, name, points, pin_hash, ref_code, role, pending_op)
           VALUES (?, ?, ?, ?, '', ?, ?, NULL)`,
          [pulled.id, pulled.phone, pulled.name, pulled.points, pulled.ref_code, pulled.role],
        )
      }
    }

    const keepUserPhones = [...new Set([...snapshotPhones, ...pendingPhones])]
    if (keepUserPhones.length > 0) {
      await txn.runAsync(
        `DELETE FROM users WHERE pending_op IS NULL AND phone NOT IN (${keepUserPhones.map(() => '?').join(',')})`,
        keepUserPhones,
      )
    } else {
      await txn.runAsync('DELETE FROM users WHERE pending_op IS NULL', [])
    }

    /* Awards: no provisional awards exist, so the cache mirrors the server. */
    const awardIds = snapshot.awards.map((award) => award.id)
    if (awardIds.length > 0) {
      await txn.runAsync(
        `DELETE FROM awards WHERE id NOT IN (${awardIds.map(() => '?').join(',')})`,
        awardIds,
      )
    } else {
      await txn.runAsync('DELETE FROM awards', [])
    }
    for (const award of snapshot.awards) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO awards (id, user_id, points, awarded_at, expires_at, source, voucher_code, spent_at, pending_op)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [award.id, award.user_id, award.points, award.awarded_at, award.expires_at, award.source, award.voucher_code, award.spent_at],
      )
    }

    /* Vouchers: the catalog only exists on admin devices via the pull. */
    await txn.runAsync('DELETE FROM vouchers', [])
    for (const voucher of snapshot.vouchers) {
      await txn.runAsync(
        `INSERT INTO vouchers (code, batch_id, points, created_at, redeemed_by, redeemed_at, pending_op)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [voucher.code, voucher.batch_id, voucher.points, voucher.created_at, voucher.redeemed_by, voucher.redeemed_at],
      )
    }

    /* Physical cards: keep provisional activations, mirror the server else. */
    const pendingCards = await txn.getAllAsync<PhysicalCardRow>(
      'SELECT * FROM physical_cards WHERE pending_op IS NOT NULL',
      [],
    )
    const pendingKodes = new Set(pendingCards.map((card) => card.kode))
    const snapshotKodes = new Set(snapshot.physicalCards.map((card) => card.kode))
    const keepKodes = [...new Set([...snapshotKodes, ...pendingKodes])]
    if (keepKodes.length > 0) {
      await txn.runAsync(
        `DELETE FROM physical_cards WHERE pending_op IS NULL AND kode NOT IN (${keepKodes.map(() => '?').join(',')})`,
        keepKodes,
      )
    } else {
      await txn.runAsync('DELETE FROM physical_cards', [])
    }
    for (const card of snapshot.physicalCards) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO physical_cards (kode, batch_id, created_at, activated_by, activated_at, pending_op)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [card.kode, card.batch_id, card.created_at, card.activated_by, card.activated_at],
      )
    }

    await txn.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'lastSyncAt',
      String(snapshot.serverTime),
    ])
  })
}