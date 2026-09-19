import { randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MAX_POINT_BALANCE,
  PHYSICAL_CARD_CODE_BODY_LENGTH,
  PHYSICAL_CARD_CODE_PREFIX,
  POINTS_EXPIRY_DAYS,
  REWARD_MIN_POINTS,
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_BODY_LENGTH,
  VOUCHER_CODE_PREFIX,
  type PhysicalCardBatch,
  type UserRole,
  type VoucherBatch,
  type VoucherTier,
} from '../../src/lib/loyalty'
import type {
  ActivatePhysicalCardOpPayload,
  RedeemVoucherOpPayload,
  RegisterUserOpPayload,
  SpendAwardsOpPayload,
  SyncOp,
  SyncOpResult,
  SyncSnapshot,
} from '../../src/lib/syncTypes'
import { SYNC_API_VERSION } from '../../src/lib/syncTypes'
import { buildSessionCookie } from './session'

/**
 * User data source.
 *
 * JSON files under `.data/` (users.json, vouchers.json, point-awards.json,
 * physical-cards.json), seeded on first read so the whole loyalty flow runs
 * with no external service. The directory is `server/.data` (override with
 * DATA_DIR) - run the server from the `server/` folder.
 *
 * Points are stored as individual "awards", each carrying the epoch ms it
 * expires. A user's live balance is the sum of their non-expired awards, so
 * 7-day expiry needs no cron job - it simply falls out of the query. The
 * users.points column is kept in sync as a display cache only.
 */

/** Mirrors a row of `public.users`. `points` is a cache of the live balance. */
export interface UserRow {
  id: string
  phone: string
  name: string
  points: number
  pin_hash: string
  ref_code: string
  role: UserRole
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
  /**
   * When the award was claimed at the register. Soft-deleted so sync-aware
   * devices can tell "spent" from "never existed" (a spent award is done;
   * a missing one may still be arriving through the op queue).
   */
  spent_at: string | null
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

/** Input for a self-service customer sign-up. */
export interface NewCustomerInput {
  name: string
  phone: string
  /** Raw PIN - hashed here so callers never handle a stored hash. */
  pin: string
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
}

export type RedeemVoucherResult =
  | { ok: true; code: string; pointsAdded: number; newBalance: number; expiresAt: number }
  | { ok: false; reason: 'unknown_code' | 'user_not_found' }
  | { ok: false; reason: 'already_redeemed' }
  | { ok: false; reason: 'balance_cap'; cap: number; points: number }

export const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data')
const DATA_FILE = join(DATA_DIR, 'users.json')
const VOUCHERS_FILE = join(DATA_DIR, 'vouchers.json')
const AWARDS_FILE = join(DATA_DIR, 'point-awards.json')
const PHYSICAL_CARDS_FILE = join(DATA_DIR, 'physical-cards.json')

/* -------------------------------------------------------------------------- */
/* PIN hashing                                                                */
/* -------------------------------------------------------------------------- */

/** Hash a PIN for storage: `scrypt$<salt>$<derivedKey>`. */
export function hashPin(pin: string): string {
  const salt = randomUUID()
  const derived = scryptSync(pin, salt, 32).toString('hex')
  return `scrypt$${salt}$${derived}`
}

export function verifyPin(pin: string, storedHash: string): boolean {
  const [scheme, salt, derived] = storedHash.split('$')
  if (scheme !== 'scrypt' || !salt || !derived) return false
  const expected = Buffer.from(derived, 'hex')
  const actual = scryptSync(pin, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/* -------------------------------------------------------------------------- */
/* Award expiry                                                               */
/* -------------------------------------------------------------------------- */

/** ISO timestamp POINTS_EXPIRY_DAYS from `from` (defaults to now). */
function awardExpiry(from: number = Date.now()): string {
  return new Date(from + POINTS_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function isExpired(award: PointAwardRow, now: number = Date.now()): boolean {
  return new Date(award.expires_at).getTime() <= now
}

/* -------------------------------------------------------------------------- */
/* Local JSON store                                                           */
/* -------------------------------------------------------------------------- */

let cache: UserRow[] | null = null
let awardCache: PointAwardRow[] | null = null

/** Serializes read-modify-write cycles so concurrent requests cannot clobber. */
let queue: Promise<unknown> = Promise.resolve()
function withLock<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
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
  return `R${randomUUID().replace(/\D/g, '').slice(0, 7).padEnd(7, '0')}`
}

function seedUsers(): UserRow[] {
  return [
    {
      id: randomUUID(),
      phone: '09518050546',
      name: 'Ramyun Admin',
      points: 0,
      pin_hash: hashPin('0000'),
      ref_code: 'ADMIN',
      role: 'admin',
    },
    {
      id: randomUUID(),
      phone: '01011111111',
      name: 'Kim Minji',
      // Starts above the 5 point minimum so the reward flow is demoable.
      points: 7,
      pin_hash: hashPin('1234'),
      ref_code: 'MINJI7',
      role: 'customer',
    },
    {
      id: randomUUID(),
      phone: '01022222222',
      name: 'Lee Junho',
      points: 3,
      pin_hash: hashPin('1234'),
      ref_code: 'JUNHO3',
      role: 'customer',
    },
  ]
}

/** Seeded customers start with a matching award so their balance is live. */
function seedAwards(users: UserRow[]): PointAwardRow[] {
  const now = Date.now()
  return users
    .filter((user) => user.points > 0)
    .map((user) => ({
      id: randomUUID(),
      user_id: user.id,
      points: user.points,
      awarded_at: new Date(now).toISOString(),
      expires_at: awardExpiry(now),
      source: 'manual' as const,
      voucher_code: null,
      spent_at: null,
    }))
}

async function loadUsers(): Promise<UserRow[]> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(DATA_FILE, 'utf8')) as UserRow[]
    // One-time migration for pre-ledger installs: the users file predates
    // point awards, so derive one award per user from its cached balance.
    const awardsExist = await access(AWARDS_FILE).then(
      () => true,
      () => false,
    )
    if (!awardsExist) {
      const seeded = seedAwards(cache)
      if (seeded.length > 0) await persistAwards(seeded)
    }
  } catch {
    cache = seedUsers()
    await persistUsers(cache)
    await persistAwards(seedAwards(cache))
  }
  return cache
}

async function persistUsers(users: UserRow[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true })
  await writeFile(DATA_FILE, JSON.stringify(users, null, 2), 'utf8')
}

async function loadAwards(): Promise<PointAwardRow[]> {
  if (awardCache) return awardCache
  try {
    awardCache = JSON.parse(await readFile(AWARDS_FILE, 'utf8')) as PointAwardRow[]
    // One-time migration for installs written before soft-deletes existed.
    let migrated = false
    for (const award of awardCache) {
      if (award.spent_at === undefined) {
        award.spent_at = null
        migrated = true
      }
    }
    if (migrated) await persistAwards(awardCache)
  } catch {
    // A missing awards file just means no points have been granted yet.
    awardCache = []
    await persistAwards(awardCache)
  }
  return awardCache
}

async function persistAwards(awards: PointAwardRow[]): Promise<void> {
  await mkdir(dirname(AWARDS_FILE), { recursive: true })
  await writeFile(AWARDS_FILE, JSON.stringify(awards, null, 2), 'utf8')
}

/** Non-expired, unspent awards for one user, oldest first. */
async function liveAwards(userId: string): Promise<PointAwardRow[]> {
  const now = Date.now()
  const awards = await loadAwards()
  return awards
    .filter((award) => award.user_id === userId && award.spent_at == null && !isExpired(award, now))
    .sort((a, b) => a.awarded_at.localeCompare(b.awarded_at))
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
  const awards = await liveAwards(userId)
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
  const cards = await loadPhysicalCards()
  return cards.some((card) => card.activated_by === userId)
}

/* -------------------------------------------------------------------------- */
/* Local card store                                                           */
/* -------------------------------------------------------------------------- */

let voucherCache: VoucherRow[] | null = null

async function loadVouchers(): Promise<VoucherRow[]> {
  if (voucherCache) return voucherCache
  try {
    voucherCache = JSON.parse(await readFile(VOUCHERS_FILE, 'utf8')) as VoucherRow[]
  } catch {
    // No cards printed yet - an empty list is the correct starting state.
    voucherCache = []
    await persistVouchers(voucherCache)
  }
  return voucherCache
}

async function persistVouchers(vouchers: VoucherRow[]): Promise<void> {
  await mkdir(dirname(VOUCHERS_FILE), { recursive: true })
  await writeFile(VOUCHERS_FILE, JSON.stringify(vouchers, null, 2), 'utf8')
}

/** Fresh random code, retrying if it happens to match one already in `taken`. */
function generateVoucherCode(taken?: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let body = ''
    for (let i = 0; i < VOUCHER_CODE_BODY_LENGTH; i += 1) {
      body += VOUCHER_CODE_ALPHABET[randomInt(0, VOUCHER_CODE_ALPHABET.length)]
    }
    const code = `${VOUCHER_CODE_PREFIX}${body}`
    if (!taken?.has(code)) return code
  }
  throw new Error('Could not generate a unique card code')
}

/* -------------------------------------------------------------------------- */
/* Local physical-card store                                                  */
/* -------------------------------------------------------------------------- */

/** Mirrors a row of `public.physical_cards`. */
export interface PhysicalCardRow {
  kode: string
  batch_id: string
  created_at: string
  /** null while the printed card is still unactivated/unsold. */
  activated_by: string | null
  activated_at: string | null
}

let physicalCardCache: PhysicalCardRow[] | null = null

async function loadPhysicalCards(): Promise<PhysicalCardRow[]> {
  if (physicalCardCache) return physicalCardCache
  try {
    physicalCardCache = JSON.parse(await readFile(PHYSICAL_CARDS_FILE, 'utf8')) as PhysicalCardRow[]
  } catch {
    // No physical cards printed yet - an empty list is the correct start state.
    physicalCardCache = []
    await persistPhysicalCards(physicalCardCache)
  }
  return physicalCardCache
}

async function persistPhysicalCards(cards: PhysicalCardRow[]): Promise<void> {
  await mkdir(dirname(PHYSICAL_CARDS_FILE), { recursive: true })
  await writeFile(PHYSICAL_CARDS_FILE, JSON.stringify(cards, null, 2), 'utf8')
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
/* Catalog seeding                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mints a starter pool of printed cards on the very first run so the app is
 * demoable without an admin UI: RMY reward codes across the point tiers and a
 * few blank TNL card kodes. Returns what was created (empty when data already
 * exists) so the boot log can show sample codes.
 */
export async function seedCatalog(): Promise<{ voucherCodes: string[]; cardKodes: string[] }> {
  await loadUsers()

  const created: { voucherCodes: string[]; cardKodes: string[] } = { voucherCodes: [], cardKodes: [] }

  const vouchersExist = await access(VOUCHERS_FILE).then(
    () => true,
    () => false,
  )
  if (!vouchersExist) {
    const tiers: VoucherTier[] = [...Array(2).fill(1), ...Array(2).fill(2), ...Array(2).fill(3)]
    const taken = new Set<string>()
    const batchId = randomUUID()
    const now = new Date().toISOString()
    const batch: VoucherRow[] = []

    for (const points of tiers) {
      const code = generateVoucherCode(taken)
      taken.add(code)
      batch.push({
        code,
        batch_id: batchId,
        points,
        created_at: now,
        redeemed_by: null,
        redeemed_at: null,
      })
    }

    voucherCache = batch
    await persistVouchers(batch)
    created.voucherCodes = batch.map((voucher) => voucher.code)
  }

  const cardsExist = await access(PHYSICAL_CARDS_FILE).then(
    () => true,
    () => false,
  )
  if (!cardsExist) {
    const taken = new Set<string>()
    const batchId = randomUUID()
    const now = new Date().toISOString()
    const batch: PhysicalCardRow[] = []

    for (let i = 0; i < 4; i += 1) {
      const kode = generatePhysicalCardCode(taken)
      taken.add(kode)
      batch.push({
        kode,
        batch_id: batchId,
        created_at: now,
        activated_by: null,
        activated_at: null,
      })
    }

    physicalCardCache = batch
    await persistPhysicalCards(batch)
    created.cardKodes = batch.map((card) => card.kode)
  }

  return created
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getUserById(id: string): Promise<UserRow | null> {
  const users = await loadUsers()
  return users.find((user) => user.id === id) ?? null
}

export async function getUserByPhone(phone: string): Promise<UserRow | null> {
  const users = await loadUsers()
  return users.find((user) => user.phone === phone) ?? null
}

/** Total number of registered customer accounts (admins excluded). */
export async function countCustomers(): Promise<number> {
  const users = await loadUsers()
  return users.filter((user) => user.role === 'customer').length
}

/**
 * Registers a new customer starting at 0 points. Returns a discriminated result
 * so the route can map a duplicate phone number to a 409.
 */
export async function createCustomer(input: NewCustomerInput): Promise<CreateUserResult> {
  const pinHash = hashPin(input.pin)
  return withLock(async () => {
    const users = await loadUsers()
    if (users.some((user) => user.phone === input.phone)) {
      return { ok: false as const, reason: 'phone_taken' as const }
    }

    const user: UserRow = {
      id: randomUUID(),
      phone: input.phone,
      name: input.name,
      points: 0,
      pin_hash: pinHash,
      ref_code: generateRefCode(input.name, new Set(users.map((candidate) => candidate.ref_code))),
      role: 'customer',
    }

    users.push(user)
    await persistUsers(users)
    return { ok: true as const, user: { ...user } }
  })
}

/**
 * Claims a customer's whole live balance as a discount: every non-expired
 * award is spent at once, so after the scan the balance is zero and collecting
 * can start again.
 */
export async function redeemRewardPoints(
  userId: string,
  minPoints: number,
): Promise<RedeemResult> {
  return withLock(async () => {
    const users = await loadUsers()
    const user = users.find((candidate) => candidate.id === userId)
    if (!user) return { ok: false as const, reason: 'user_not_found' as const }

    const awards = await liveAwards(userId)
    const liveTotal = awards.reduce((total, award) => total + award.points, 0)
    if (liveTotal < minPoints) {
      return { ok: false as const, reason: 'insufficient_points' as const, points: liveTotal }
    }

    const spent = liveTotal
    const awardsRef = await loadAwards()
    const spentAt = new Date().toISOString()
    for (const award of awards) {
      const stored = awardsRef.find((candidate) => candidate.id === award.id)
      if (stored) stored.spent_at = spentAt
    }
    user.points = 0

    await Promise.all([persistAwards(awardsRef), persistUsers(users)])
    return {
      ok: true as const,
      user: { id: user.id, name: user.name },
      remainingPoints: 0,
      pointsSpent: spent,
    }
  })
}

/**
 * Resolves a physical-card kode to the account that activated it, so the
 * cashier can scan the printed card instead of the customer's phone. Returns
 * 'unknown_kode' for a kode that was never printed and 'not_activated' for a
 * real card no customer has linked yet (e.g. one still on the shelf).
 */
export async function resolvePhysicalCardOwner(
  kode: string,
): Promise<{ ok: true; userId: string } | { ok: false; reason: 'unknown_kode' | 'not_activated' }> {
  const cards = await loadPhysicalCards()
  const card = cards.find((candidate) => candidate.kode === kode)
  if (!card) return { ok: false, reason: 'unknown_kode' }
  if (!card.activated_by) return { ok: false, reason: 'not_activated' }
  return { ok: true, userId: card.activated_by }
}

/**
 * Activates a physical card for a customer: one transaction-critical update
 * guarded by `activated_at is null`, so two accounts scanning the same printed
 * QR at the same instant can never both win - and an already-linked card is
 * refused without disturbing the existing link.
 */
export async function activatePhysicalCard(input: {
  kode: string
  userId: string
}): Promise<
  | { ok: true; kode: string; activatedAt: string }
  | { ok: false; reason: 'unknown_kode' | 'user_not_found' | 'already_activated' }
> {
  return withLock(async () => {
    const users = await loadUsers()
    if (!users.some((candidate) => candidate.id === input.userId)) {
      return { ok: false as const, reason: 'user_not_found' as const }
    }

    const cards = await loadPhysicalCards()
    const card = cards.find((candidate) => candidate.kode === input.kode)
    if (!card) return { ok: false as const, reason: 'unknown_kode' as const }
    if (card.activated_at) return { ok: false as const, reason: 'already_activated' as const }

    card.activated_by = input.userId
    card.activated_at = new Date().toISOString()
    await persistPhysicalCards(cards)
    return { ok: true as const, kode: card.kode, activatedAt: card.activated_at }
  })
}

/**
 * Claims a card for a customer: marks the card used, records an expiring point
 * award, and refreshes the cached balance. All writes land in one critical
 * section so a code submitted twice at the same instant can only ever pay out
 * once, and a claim that would push the balance past the cap is refused with
 * the card left unused, so no value is ever lost.
 */
export async function redeemVoucher(input: {
  code: string
  userId: string
}): Promise<RedeemVoucherResult> {
  return withLock(async () => {
    const users = await loadUsers()
    const user = users.find((candidate) => candidate.id === input.userId)
    if (!user) return { ok: false as const, reason: 'user_not_found' as const }

    const vouchers = await loadVouchers()
    const voucher = vouchers.find((candidate) => candidate.code === input.code)
    if (!voucher) return { ok: false as const, reason: 'unknown_code' as const }
    // `redeemed_at` is the spent marker; `redeemed_by` is only an audit trail.
    if (voucher.redeemed_at) return { ok: false as const, reason: 'already_redeemed' as const }

    const awards = await liveAwards(input.userId)
    const liveTotal = awards.reduce((total, award) => total + award.points, 0)
    if (liveTotal + voucher.points > MAX_POINT_BALANCE) {
      return {
        ok: false as const,
        reason: 'balance_cap' as const,
        cap: MAX_POINT_BALANCE,
        points: liveTotal,
      }
    }

    const now = Date.now()
    const award: PointAwardRow = {
      id: randomUUID(),
      user_id: user.id,
      points: voucher.points,
      awarded_at: new Date(now).toISOString(),
      expires_at: awardExpiry(now),
      source: 'voucher',
      voucher_code: voucher.code,
      spent_at: null,
    }

    const awardsRef = await loadAwards()
    awardsRef.push(award)
    voucher.redeemed_by = user.id
    voucher.redeemed_at = new Date(now).toISOString()
    user.points = Math.min(MAX_POINT_BALANCE, liveTotal + voucher.points)

    await Promise.all([persistAwards(awardsRef), persistVouchers(vouchers), persistUsers(users)])
    return {
      ok: true as const,
      code: voucher.code,
      pointsAdded: voucher.points,
      newBalance: user.points,
      expiresAt: new Date(award.expires_at).getTime(),
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Admin catalog management                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Points-card roll-up, merged by denomination and newest first. One entry per
 * tier shows how much of the printed pool has come back, e.g. 4 / 10 claimed.
 */
export async function listVoucherBatches(limit = 20): Promise<VoucherBatch[]> {
  const vouchers = await loadVouchers()
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
  const vouchers = await loadVouchers()
  return vouchers
    .filter((voucher) => voucher.batch_id === batchId)
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** Every card of one points denomination, across merged batches, newest first. */
export async function listVoucherCardsByPoints(points: number): Promise<VoucherRow[]> {
  const vouchers = await loadVouchers()
  return vouchers
    .filter((voucher) => voucher.points === points)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
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
  const createdAt = new Date().toISOString()
  return withLock(async () => {
    const vouchers = await loadVouchers()
    const latest = vouchers
      .filter((voucher) => voucher.points === input.points)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    const batchId = latest?.batch_id ?? randomUUID()
    const taken = new Set(vouchers.map((voucher) => voucher.code))
    const cards: VoucherRow[] = []

    for (let i = 0; i < input.quantity; i += 1) {
      const code = generateVoucherCode(taken)
      taken.add(code)
      cards.push({
        code,
        batch_id: batchId,
        points: input.points,
        created_at: createdAt,
        redeemed_by: null,
        redeemed_at: null,
      })
    }

    vouchers.push(...cards)
    await persistVouchers(vouchers)
    return { batchId, cards }
  })
}

/**
 * Permanently deletes claimed cards only, so used-up runs do not clog the admin
 * list. Unclaimed codes in the request are ignored, no matter what is listed.
 */
export async function deleteVouchers(codes: string[]): Promise<{ deleted: number }> {
  if (codes.length === 0) return { deleted: 0 }
  const wanted = new Set(codes)
  return withLock(async () => {
    const vouchers = await loadVouchers()
    let deleted = 0
    const kept: VoucherRow[] = []
    for (const voucher of vouchers) {
      if (wanted.has(voucher.code) && voucher.redeemed_at) {
        deleted += 1
        continue
      }
      kept.push(voucher)
    }
    if (deleted > 0) {
      // Reassign the cache, not just the file: loadVouchers() hands out the
      // cached array itself, so a disk-only write would keep serving the
      // deleted rows until restart.
      voucherCache = kept
      await persistVouchers(kept)
    }
    return { deleted }
  })
}

/** Roll-up of one physical-card print run, newest first. */
export async function listPhysicalCardBatches(): Promise<PhysicalCardBatch[]> {
  const cards = await loadPhysicalCards()
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
  const cards = await loadPhysicalCards()
  return cards
    .filter((card) => card.batch_id === batchId)
    .sort((a, b) => a.kode.localeCompare(b.kode))
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
  const createdAt = new Date().toISOString()
  const batchId = randomUUID()
  return withLock(async () => {
    const cards = await loadPhysicalCards()
    const taken = new Set(cards.map((card) => card.kode))
    const batch: PhysicalCardRow[] = []

    for (let i = 0; i < quantity; i += 1) {
      const kode = generatePhysicalCardCode(taken)
      taken.add(kode)
      batch.push({
        kode,
        batch_id: batchId,
        created_at: createdAt,
        activated_by: null,
        activated_at: null,
      })
    }

    cards.push(...batch)
    await persistPhysicalCards(cards)
    return { batchId, cards: batch }
  })
}

/* -------------------------------------------------------------------------- */
/* Offline-first sync                                                          */
/* -------------------------------------------------------------------------- */

const SYNC_OPS_FILE = join(DATA_DIR, 'sync-ops.json')
const SYNC_HELD_FILE = join(DATA_DIR, 'sync-held.json')

/** One applied op's idempotent result (replayed to any device that re-pushes). */
interface JournalEntry {
  opId: string
  type: string
  appliedAt: string
  result: SyncOpResult
}

/** A spend waiting on awards that have not arrived yet (held, not rejected). */
interface HeldOp {
  op: SyncOp
  heldSince: number
}

/** Seven days is long enough for a queued points-batch to land; beyond that the
 *  order is abandoned rather than left ghosted forever. */
const HELD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

let journalCache: JournalEntry[] | null = null
let heldCache: HeldOp[] | null = null

async function loadSyncJournal(): Promise<JournalEntry[]> {
  if (journalCache) return journalCache
  try {
    journalCache = JSON.parse(await readFile(SYNC_OPS_FILE, 'utf8')) as JournalEntry[]
  } catch {
    journalCache = []
  }
  return journalCache
}

async function persistSyncJournal(journal: JournalEntry[]): Promise<void> {
  await mkdir(dirname(SYNC_OPS_FILE), { recursive: true })
  await writeFile(SYNC_OPS_FILE, JSON.stringify(journal, null, 2), 'utf8')
}

async function loadHeldOps(): Promise<HeldOp[]> {
  if (heldCache) return heldCache
  try {
    heldCache = JSON.parse(await readFile(SYNC_HELD_FILE, 'utf8')) as HeldOp[]
  } catch {
    heldCache = []
  }
  return heldCache
}

async function persistHeldOps(held: HeldOp[]): Promise<void> {
  await mkdir(dirname(SYNC_HELD_FILE), { recursive: true })
  await writeFile(SYNC_HELD_FILE, JSON.stringify(held, null, 2), 'utf8')
}

async function applyOp(op: SyncOp): Promise<{ kind: 'held' } | { kind: 'result'; result: SyncOpResult }> {
  if (op.type === 'register_user') {
    const payload = op.payload as RegisterUserOpPayload
    const users = await loadUsers()
    if (users.some((user) => user.phone === payload.phone)) {
      return {
        kind: 'result',
        result: { opId: op.opId, ok: false, reason: 'phone_taken', message: 'That phone number is already registered' },
      }
    }
    if (users.some((user) => user.id === payload.userId)) {
      return {
        kind: 'result',
        result: { opId: op.opId, ok: false, reason: 'id_taken', message: 'That account already exists' },
      }
    }

    const refCode = generateRefCode(payload.name, new Set(users.map((user) => user.ref_code)))
    const user: UserRow = {
      id: payload.userId,
      phone: payload.phone,
      name: payload.name,
      points: 0,
      pin_hash: hashPin(payload.pin),
      ref_code: refCode,
      role: 'customer',
    }
    users.push(user)
    await persistUsers(users)

    const authCookie = buildSessionCookie({ userId: user.id, role: 'customer', iat: Date.now() })
    return {
      kind: 'result',
      result: {
        opId: op.opId,
        ok: true,
        state: { customerName: user.name, authCookie },
      },
    }
  }

  if (op.type === 'redeem_voucher') {
    const payload = op.payload as RedeemVoucherOpPayload
    const users = await loadUsers()
    const user = users.find((candidate) => candidate.id === payload.userId)
    if (!user) {
      return { kind: 'result', result: { opId: op.opId, ok: false, reason: 'user_not_found', message: 'Account not found' } }
    }

    const vouchers = await loadVouchers()
    const voucher = vouchers.find((candidate) => candidate.code === payload.code)
    if (!voucher) {
      return {
        kind: 'result',
        result: {
          opId: op.opId,
          ok: false,
          reason: 'unknown_code',
          message: 'That kode was not recognised or has already been used — vouchers start with RMY, e.g. RMY-4K7P-2XQ9',
        },
      }
    }
    if (voucher.redeemed_at) {
      return { kind: 'result', result: { opId: op.opId, ok: false, reason: 'already_redeemed', message: 'That card has already been used' } }
    }

    const awards = await loadAwards()
    const live = awards
      .filter((award) => award.user_id === user.id && award.spent_at == null && !isExpired(award))
      .reduce((total, award) => total + award.points, 0)
    if (live + voucher.points > MAX_POINT_BALANCE) {
      return {
        kind: 'result',
        result: {
          opId: op.opId,
          ok: false,
          reason: 'balance_cap',
          message: `You have ${live} points - the maximum is ${MAX_POINT_BALANCE}. Redeem your points before adding more.`,
        },
      }
    }

    awards.push({
      id: payload.awardId,
      user_id: user.id,
      points: voucher.points,
      awarded_at: new Date(payload.awardedAt).toISOString(),
      expires_at: awardExpiry(payload.awardedAt),
      source: 'voucher',
      voucher_code: voucher.code,
      spent_at: null,
    })
    voucher.redeemed_by = user.id
    voucher.redeemed_at = new Date().toISOString()
    user.points = Math.min(MAX_POINT_BALANCE, live + voucher.points)

    await Promise.all([persistAwards(awards), persistVouchers(vouchers), persistUsers(users)])
    return {
      kind: 'result',
      result: { opId: op.opId, ok: true, state: { customerName: user.name } },
    }
  }

  if (op.type === 'activate_physical_card') {
    const payload = op.payload as ActivatePhysicalCardOpPayload
    const users = await loadUsers()
    if (!users.some((candidate) => candidate.id === payload.userId)) {
      return { kind: 'result', result: { opId: op.opId, ok: false, reason: 'user_not_found', message: 'Account not found' } }
    }

    const cards = await loadPhysicalCards()
    const card = cards.find((candidate) => candidate.kode === payload.kode)
    if (!card) {
      return {
        kind: 'result',
        result: { opId: op.opId, ok: false, reason: 'unknown_kode', message: 'That card kode was not recognised - please check it' },
      }
    }
    if (card.activated_at) {
      return {
        kind: 'result',
        result: { opId: op.opId, ok: false, reason: 'already_activated', message: 'That card has already been activated by another account' },
      }
    }

    card.activated_by = payload.userId
    card.activated_at = new Date().toISOString()
    await persistPhysicalCards(cards)
    return {
      kind: 'result',
      result: {
        opId: op.opId,
        ok: true,
        state: { customerName: users.find((candidate) => candidate.id === payload.userId)?.name },
      },
    }
  }

  if (op.type === 'spend_awards') {
    const payload = op.payload as SpendAwardsOpPayload
    const users = await loadUsers()
    const user = users.find((candidate) => candidate.id === payload.userId)
    if (!user) {
      return { kind: 'result', result: { opId: op.opId, ok: false, reason: 'user_not_found', message: 'Customer not found' } }
    }

    const awards = await loadAwards()
    const wanted = new Set(payload.awardIds)
    const missing = payload.awardIds.filter((id) => !awards.some((award) => award.id === id))
    if (missing.length > 0) {
      // The awards are probably still travelling through the op queue on the
      // customer's phone. Hold - not reject - so when the claim lands this
      // spend can still win.
      return { kind: 'held' }
    }

    const requested = awards.filter((award) => wanted.has(award.id))
    if (requested.some((award) => award.spent_at != null)) {
      return {
        kind: 'result',
        result: {
          opId: op.opId,
          ok: false,
          reason: 'already_spent',
          message: "This reward has already been redeemed elsewhere - the customer's points are gone.",
        },
      }
    }
    const expired = requested.find((award) => isExpired(award))
    if (expired) {
      return {
        kind: 'result',
        result: {
          opId: op.opId,
          ok: false,
          reason: 'expired',
          message: "This reward has expired - the customer's points are no longer valid.",
        },
      }
    }

    const allLive = awards
      .filter((award) => award.user_id === user.id && award.spent_at == null && !isExpired(award))
      .reduce((total, award) => total + award.points, 0)
    if (allLive < REWARD_MIN_POINTS) {
      return {
        kind: 'result',
        result: {
          opId: op.opId,
          ok: false,
          reason: 'insufficient_points',
          message: `This customer needs at least ${REWARD_MIN_POINTS} points to claim - they only have ${allLive}`,
        },
      }
    }

    const spentAt = new Date().toISOString()
    for (const award of requested) award.spent_at = spentAt
    const remaining = awards
      .filter((award) => award.user_id === user.id && award.spent_at == null && !isExpired(award))
      .reduce((total, award) => total + award.points, 0)
    user.points = remaining

    await Promise.all([persistAwards(awards), persistUsers(users)])
    return {
      kind: 'result',
      result: {
        opId: op.opId,
        ok: true,
        state: { remainingBalance: remaining, customerName: user.name },
      },
    }
  }

  return { kind: 'result', result: { opId: op.opId, ok: false, reason: 'unknown_op', message: 'Unknown operation type' } }
}

/**
 * Applies a batch of queued ops atomically under the writer lock. Held spends
 * (waiting on awards that have not appeared yet) are re-checked before each
 * batch and persisted so a server restart does not lose them.
 */
export async function applySyncOps(ops: SyncOp[]): Promise<{ results: SyncOpResult[]; serverTime: number }> {
  return withLock(async () => {
    const journal = await loadSyncJournal()
    const held = await loadHeldOps()
    const results: SyncOpResult[] = []
    const stillHeld: HeldOp[] = []
    const queue: HeldOp[] = [...held, ...ops.map((op) => ({ op, heldSince: Date.now() } as HeldOp))]

    for (const entry of queue) {
      const existing = journal.find((candidate) => candidate.opId === entry.op.opId)
      if (existing) {
        results.push(existing.result)
        continue
      }

      if (Date.now() - entry.heldSince > HELD_MAX_AGE_MS) {
        const result: SyncOpResult = {
          opId: entry.op.opId,
          ok: false,
          reason: 'expired',
          message: "This reward could not be finalized because the customer's points never arrived.",
        }
        journal.push({ opId: entry.op.opId, type: entry.op.type, appliedAt: new Date().toISOString(), result })
        results.push(result)
        continue
      }

      const applied = await applyOp(entry.op)
      if (applied.kind === 'held') {
        stillHeld.push(entry)
        continue
      }

      journal.push({
        opId: entry.op.opId,
        type: entry.op.type,
        appliedAt: new Date().toISOString(),
        result: applied.result,
      })
      results.push(applied.result)
    }

    heldCache = stillHeld
    journalCache = journal
    await persistHeldOps(stillHeld)
    await persistSyncJournal(journal)

    return { results, serverTime: Date.now() }
  })
}

/** Role-scoped authoritative snapshot for one signed-in device. */
export async function buildSnapshot(role: UserRole, userId: string): Promise<SyncSnapshot> {
  const users = await loadUsers()
  const seen = role === 'admin' ? users : users.filter((user) => user.id === userId)

  const awards = (await loadAwards()).filter((award) => (role === 'admin' ? true : award.user_id === userId))
  const vouchers = role === 'admin' ? await loadVouchers() : []
  const physicalCards = (await loadPhysicalCards()).filter(
    (card) => (role === 'admin' ? true : card.activated_by === userId),
  )

  return {
    version: SYNC_API_VERSION,
    serverTime: Date.now(),
    users: seen.map((user) => ({
      id: user.id,
      phone: user.phone,
      name: user.name,
      points: user.points,
      ref_code: user.ref_code,
      role: user.role,
    })),
    awards,
    vouchers,
    physicalCards,
  }
}