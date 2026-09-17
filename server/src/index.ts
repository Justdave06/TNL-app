import express, { type NextFunction, type Request, type Response } from 'express'
import {
  isVoucherTier,
  MAX_PHYSICAL_BATCH_SIZE,
  MAX_POINT_BALANCE,
  MAX_VOUCHER_BATCH_SIZE,
  discountPercentForPoints,
  normalizeVoucherCode,
  parsePhysicalCardQrPayload,
  parseRewardPayload,
  REWARD_MIN_POINTS,
  VOUCHER_POINT_TIERS,
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
} from '../../src/lib/loyalty'
import { AppError, httpError, requireAdmin, requireUser } from './auth'
import {
  activatePhysicalCard,
  countCustomers,
  createCustomer,
  createPhysicalCardBatch,
  createVoucherBatch,
  deleteVouchers,
  getUserByPhone,
  listPhysicalCardBatches,
  listPhysicalCardsByBatch,
  listVoucherBatches,
  listVoucherCards,
  listVoucherCardsByPoints,
  redeemRewardPoints,
  redeemVoucher,
  resolvePhysicalCardOwner,
  seedCatalog,
  verifyPin,
} from './db'
import { DATA_DIR } from './db'
import { endUserSession, startUserSession } from './session'
import { toCurrentUser } from './serializers'

/**
 * Standalone REST API for the TNL Rewards app.
 *
 * Mirrors the web backend's /api/* routes exactly (same paths, status codes,
 * response shapes and error wording) so the mobile client works unchanged.
 * Sessions are HMAC-signed cookies; the app captures Set-Cookie and re-attaches
 * it as a Cookie header on every request.
 */

const PORT = Number(process.env.PORT ?? 3000)

interface LoginBody {
  phone?: string
  pin?: string
}

interface RegisterBody {
  name?: string
  phone?: string
  pin?: string
}

interface KodeBody {
  /** Raw scanned QR string or hand-typed code. */
  code?: string
}

interface RedeemRewardBody {
  /** The raw scanned QR string, or a bare customer id (manual entry). */
  code?: string
  /** The customer id carried inside the scanned reward QR code. */
  userId?: string
}

interface CreateVoucherBatchBody {
  points?: number
  quantity?: number
}

interface CreatePhysicalCardsBody {
  quantity?: number
}

interface DeleteVouchersBody {
  /** The kodes to remove - must all be claimed cards. */
  codes?: string[]
}

/** 9-11 digits starting with 0, e.g. 01012345678. */
const PHONE_PATTERN = /^0\d{8,10}$/

const app = express()

app.disable('x-powered-by')
app.use(express.json())

// Native apps skip CORS entirely; permissive headers keep Expo web usable too.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

/** POST /api/auth/login - demo-friendly phone + PIN sign-in. */
app.post('/api/auth/login', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as LoginBody

  const phone = (body.phone ?? '').replace(/\D/g, '')
  const pin = (body.pin ?? '').trim()

  if (!phone || !pin) {
    throw httpError(400, 'Phone number and PIN are required')
  }

  const user = await getUserByPhone(phone)
  if (!user || !verifyPin(pin, user.pin_hash)) {
    throw httpError(401, 'Invalid phone number or PIN')
  }

  startUserSession(res, { userId: user.id, role: user.role, iat: Date.now() })
  res.json(await toCurrentUser(user))
})

/** POST /api/auth/register - self-service customer sign-up, signed in on success. */
app.post('/api/auth/register', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as RegisterBody

  const name = (body.name ?? '').trim().replace(/\s+/g, ' ')
  const phone = (body.phone ?? '').replace(/\D/g, '')
  const pin = (body.pin ?? '').trim()

  if (!name || !phone || !pin) {
    throw httpError(400, 'Name, phone number and PIN are required')
  }
  if (name.length > 40) {
    throw httpError(400, 'Name must be 40 characters or fewer')
  }
  if (!PHONE_PATTERN.test(phone)) {
    throw httpError(400, 'Enter a valid phone number')
  }
  if (!/^\d{4,6}$/.test(pin)) {
    throw httpError(400, 'PIN must be 4 to 6 digits')
  }

  const result = await createCustomer({ name, phone, pin })
  if (!result.ok) {
    throw httpError(409, 'That phone number is already registered')
  }

  startUserSession(res, { userId: result.user.id, role: result.user.role, iat: Date.now() })
  res.json(await toCurrentUser(result.user))
})

/** POST /api/auth/logout - drops the session cookie. */
app.post('/api/auth/logout', (req: Request, res: Response): void => {
  endUserSession(res)
  res.json({ success: true })
})

/* -------------------------------------------------------------------------- */
/* Customer                                                                   */
/* -------------------------------------------------------------------------- */

/** GET /api/me - the dashboard polls this; a dropped balance closes the QR modal. */
app.get('/api/me', async (req: Request, res: Response): Promise<void> => {
  const user = await requireUser(req)
  res.json(await toCurrentUser(user))
})

/**
 * POST /api/vouchers/redeem - points come from the stored card, never the body,
 * and the balance cap is enforced with the card left unused.
 */
app.post('/api/vouchers/redeem', async (req: Request, res: Response): Promise<void> => {
  const user = await requireUser(req)
  const body = (req.body ?? {}) as KodeBody

  const code = normalizeVoucherCode(body.code ?? '')
  if (!code) {
    throw httpError(
      400,
      'That is not a valid rewards kode — vouchers start with RMY, e.g. RMY-4K7P-2XQ9',
    )
  }

  const result = await redeemVoucher({ code, userId: user.id })

  if (!result.ok) {
    if (result.reason === 'already_redeemed') {
      throw httpError(409, 'That card has already been used')
    }
    if (result.reason === 'unknown_code') {
      throw httpError(
        404,
        'That kode was not recognised or has already been used — vouchers start with RMY, e.g. RMY-4K7P-2XQ9',
      )
    }
    if (result.reason === 'balance_cap') {
      throw httpError(
        409,
        `You have ${result.points} points - the maximum is ${MAX_POINT_BALANCE}. ` +
          'Redeem your points before adding more.',
      )
    }
    throw httpError(404, 'Account not found')
  }

  const response: RedeemVoucherResponse = {
    success: true,
    code: result.code,
    pointsAdded: result.pointsAdded,
    newBalance: result.newBalance,
    expiresAt: result.expiresAt,
  }
  res.json(response)
})

/**
 * POST /api/physical-cards/activate - links a printed card to the signed-in
 * account; first activation flips the account's hasPhysicalCard flag.
 */
app.post('/api/physical-cards/activate', async (req: Request, res: Response): Promise<void> => {
  const user = await requireUser(req)
  const body = (req.body ?? {}) as KodeBody

  const kode = parsePhysicalCardQrPayload(body.code ?? '')
  if (!kode) {
    throw httpError(400, 'That is not a TNL card kode - check the code printed on the card')
  }

  const result = await activatePhysicalCard({ kode, userId: user.id })

  if (!result.ok) {
    if (result.reason === 'already_activated') {
      throw httpError(409, 'That card has already been activated by another account')
    }
    if (result.reason === 'unknown_kode') {
      throw httpError(404, 'That card kode was not recognised - please check it')
    }
    throw httpError(404, 'Account not found')
  }

  const response: ActivatePhysicalCardResponse = {
    success: true,
    code: result.kode,
    activatedAt: new Date(result.activatedAt).getTime(),
  }
  res.json(response)
})

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/redeem-reward - the cashier scanner. Accepts the customer's
 * reward QR, the QR on an activated physical TNL card, or a bare customer id.
 */
app.post('/api/admin/redeem-reward', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)

  const body = (req.body ?? {}) as RedeemRewardBody
  const raw = typeof body.code === 'string' ? body.code.trim() : ''
  let userId = typeof body.userId === 'string' ? body.userId.trim() : ''

  if (!userId && raw) {
    const reward = parseRewardPayload(raw)
    if (reward) {
      userId = reward.userId
    } else {
      const kode = parsePhysicalCardQrPayload(raw)
      if (kode) {
        const card = await resolvePhysicalCardOwner(kode)
        if (!card.ok) {
          throw httpError(
            404,
            card.reason === 'not_activated'
              ? 'That card has not been activated yet - the customer must activate it first'
              : 'That card kode was not recognised - please check it',
          )
        }
        userId = card.userId
      }
    }
  }

  if (!userId) {
    throw httpError(400, 'Scan the customer\u2019s reward QR, their TNL card, or enter a customer id')
  }

  const result = await redeemRewardPoints(userId, REWARD_MIN_POINTS)

  if (!result.ok) {
    if (result.reason === 'user_not_found') {
      throw httpError(404, 'Customer not found')
    }
    throw httpError(
      400,
      `This customer needs at least ${REWARD_MIN_POINTS} points to claim - they only have ${result.points}`,
    )
  }

  const response: RedeemRewardResponse = {
    success: true,
    userId: result.user.id,
    customerName: result.user.name,
    remainingPoints: result.remainingPoints,
    discountApplied: `${discountPercentForPoints(result.pointsSpent)}%`,
    pointsSpent: result.pointsSpent,
  }
  res.json(response)
})

/** GET /api/admin/users/count - registered customer accounts, for a stats card. */
app.get('/api/admin/users/count', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)
  res.json({ count: await countCustomers() })
})

/** POST /api/admin/vouchers - mint a batch of single-use points cards. */
app.post('/api/admin/vouchers', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)

  const body = (req.body ?? {}) as CreateVoucherBatchBody
  const points = Number(body.points)
  const quantity = Number(body.quantity)

  if (!isVoucherTier(points)) {
    throw httpError(400, `Points must be one of ${VOUCHER_POINT_TIERS.join(', ')}`)
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_VOUCHER_BATCH_SIZE) {
    throw httpError(400, `Quantity must be between 1 and ${MAX_VOUCHER_BATCH_SIZE}`)
  }

  const { batchId, cards } = await createVoucherBatch({ points, quantity })

  const response: CreateVoucherBatchResponse = {
    success: true,
    batch: {
      id: batchId,
      points,
      createdAt: cards[0]?.created_at ?? new Date().toISOString(),
      total: cards.length,
      redeemed: 0,
    },
    cards: cards.map((card) => ({
      code: card.code,
      points: card.points,
      redeemedAt: card.redeemed_at,
    })),
  }
  res.json(response)
})

/** GET /api/admin/vouchers - points-card roll-ups per denomination, newest first. */
app.get('/api/admin/vouchers', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)
  const response: VoucherBatchesResponse = { batches: await listVoucherBatches() }
  res.json(response)
})

/**
 * GET /api/admin/vouchers/cards-by-points?points=N
 * Every card of one denomination across merged batches, newest first.
 * Registered before the `/:batchId` route so it is not swallowed.
 */
app.get('/api/admin/vouchers/cards-by-points', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)

  const points = Number(req.query.points)
  if (!isVoucherTier(points)) {
    throw httpError(400, 'Invalid points value')
  }

  const cards = await listVoucherCardsByPoints(points)
  const response: VoucherCardsByPointsResponse = {
    points,
    cards: cards.map((card) => ({
      code: card.code,
      points: card.points,
      redeemedAt: card.redeemed_at,
    })),
  }
  res.json(response)
})

/** GET /api/admin/vouchers/:batchId - every card in one batch, for a print sheet. */
app.get('/api/admin/vouchers/:batchId', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)

  const batchId = String(req.params.batchId ?? '')
  if (!batchId) {
    throw httpError(400, 'A batch id is required')
  }

  const cards = await listVoucherCards(batchId)
  if (cards.length === 0) {
    throw httpError(404, 'Card batch not found')
  }

  const response: VoucherCardsResponse = {
    batchId,
    cards: cards.map((card) => ({
      code: card.code,
      points: card.points,
      redeemedAt: card.redeemed_at,
    })),
  }
  res.json(response)
})

/**
 * POST /api/admin/vouchers/delete
 * Permanently removes claimed points cards; unclaimed codes are ignored.
 */
app.post('/api/admin/vouchers/delete', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)

  const body = (req.body ?? {}) as DeleteVouchersBody
  const codes = (Array.isArray(body.codes) ? body.codes : [])
    .filter((code): code is string => typeof code === 'string')
    .map((code) => normalizeVoucherCode(code))
    .filter((code): code is string => code !== null)

  if (codes.length === 0) {
    throw httpError(400, 'No card kodes to delete')
  }

  const { deleted } = await deleteVouchers(codes)
  const response: DeleteVouchersResponse = { success: true, deleted }
  res.json(response)
})

/** POST /api/admin/physical-cards - mint a batch of blank physical TNL cards. */
app.post('/api/admin/physical-cards', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)

  const body = (req.body ?? {}) as CreatePhysicalCardsBody
  const quantity = Number(body.quantity)

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PHYSICAL_BATCH_SIZE) {
    throw httpError(400, `Quantity must be between 1 and ${MAX_PHYSICAL_BATCH_SIZE}`)
  }

  const { batchId, cards } = await createPhysicalCardBatch(quantity)

  const response: CreatePhysicalCardsResponse = {
    success: true,
    batch: {
      id: batchId,
      createdAt: cards[0]?.created_at ?? new Date().toISOString(),
      total: cards.length,
      activated: 0,
    },
    cards: cards.map((card) => ({
      code: card.kode,
      createdAt: card.created_at,
      activatedAt: card.activated_at,
    })),
  }
  res.json(response)
})

/** GET /api/admin/physical-cards - print runs, newest first, with activated/total. */
app.get('/api/admin/physical-cards', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)
  const response: PhysicalCardBatchesResponse = { batches: await listPhysicalCardBatches() }
  res.json(response)
})

/** GET /api/admin/physical-cards/:batchId - every card of one print run. */
app.get('/api/admin/physical-cards/:batchId', async (req: Request, res: Response): Promise<void> => {
  await requireAdmin(req)

  const batchId = String(req.params.batchId ?? '')
  if (!batchId) {
    throw httpError(400, 'A batch id is required')
  }

  const cards = await listPhysicalCardsByBatch(batchId)
  if (cards.length === 0) {
    throw httpError(404, 'Physical card batch not found')
  }

  const response: PhysicalCardBatchCardsResponse = {
    batchId,
    cards: cards.map((card) => ({
      code: card.kode,
      createdAt: card.created_at,
      activatedAt: card.activated_at,
    })),
  }
  res.json(response)
})

/* -------------------------------------------------------------------------- */
/* Fallbacks                                                                  */
/* -------------------------------------------------------------------------- */

// Unknown routes.
app.use((req: Request, res: Response): void => {
  res.status(404).json({ statusCode: 404, statusMessage: 'Not found' })
})

// Errors: render in the Nuxt/Nitro shape the client already reads.
app.use((error: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) return next(error)

  if (error instanceof AppError) {
    res.status(error.status).json({ statusCode: error.status, statusMessage: error.message })
    return
  }

  // Malformed JSON body (express.json) is a client error, everything else 500.
  if (error instanceof SyntaxError && 'status' in (error as { status?: unknown })) {
    res.status(400).json({ statusCode: 400, statusMessage: 'Invalid request body' })
    return
  }

  console.error(error)
  res.status(500).json({ statusCode: 500, statusMessage: 'Something went wrong' })
})

async function bootstrap(): Promise<void> {
  const seeded = await seedCatalog()
  if (seeded.voucherCodes.length > 0) {
    console.log(`Seeded ${seeded.voucherCodes.length} demo RMY codes: ${seeded.voucherCodes.join(', ')}`)
  }
  if (seeded.cardKodes.length > 0) {
    console.log(`Seeded ${seeded.cardKodes.length} demo TNL card kodes: ${seeded.cardKodes.join(', ')}`)
  }
  console.log(`TNL standalone API listening on :${PORT} (data: ${DATA_DIR})`)
  app.listen(PORT, '0.0.0.0')
}

bootstrap().catch((error) => {
  console.error('Failed to start the TNL API server', error)
  process.exit(1)
})