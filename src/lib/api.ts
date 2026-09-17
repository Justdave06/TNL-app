import AsyncStorage from '@react-native-async-storage/async-storage'
import { API_BASE_URL } from './config'
import type {
  ActivatePhysicalCardResponse,
  CreatePhysicalCardsResponse,
  CreateVoucherBatchResponse,
  CurrentUser,
  DeleteVouchersResponse,
  PhysicalCardBatchCardsResponse,
  PhysicalCardBatchesResponse,
  RedeemRewardResponse,
  RedeemVoucherResponse,
  VoucherBatchesResponse,
  VoucherCardsByPointsResponse,
  VoucherCardsResponse,
  VoucherTier,
} from './loyalty'

/**
 * Thin HTTP client for the shared Nuxt backend.
 *
 * Sessions are signed cookies on the server (HMAC-SHA256). React Native's fetch
 * does not persist cookies, so login/register capture the Set-Cookie header,
 * we store just the `ramyun_session` value, and every request re-attaches it as
 * a `Cookie` header. The server code is untouched.
 */

const SESSION_STORAGE_KEY = 'tnl:session'
const COOKIE_NAME = 'ramyun_session'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function readStoredSession(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

async function writeStoredSession(token: string | null): Promise<void> {
  try {
    if (token) await AsyncStorage.setItem(SESSION_STORAGE_KEY, token)
    else await AsyncStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Storage failures should never break a request.
  }
}

/** Pulls `ramyun_session=<value>` out of a Set-Cookie header line. */
function extractSessionToken(setCookie: string | null): string | null {
  if (!setCookie) return null
  const match = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match?.[1] ?? null
}

async function persistSetCookie(headers: Headers): Promise<void> {
  let token: string | null = null
  try {
    token = extractSessionToken(headers.get('set-cookie'))
  } catch {
    // Header may be stripped on some platforms - session simply won't persist.
  }
  if (token != null) await writeStoredSession(token)
}

interface RequestOptions {
  method?: 'POST'
  /** JSON body for POST requests. */
  body?: unknown
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const session = await readStoredSession()
  if (session) headers.Cookie = `${COOKIE_NAME}=${session}`

  let response: Response
  let payload: unknown = null
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    throw new ApiError(0, `Cannot reach the server at ${API_BASE_URL}`)
  }

  const text = await response.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object'
        ? ((payload as { statusMessage?: string; message?: string }).statusMessage ??
          (payload as { message?: string }).message)
        : undefined) ?? 'Something went wrong'
    throw new ApiError(response.status, message)
  }

  await persistSetCookie(response.headers)
  return payload as T
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

export async function login(phone: string, pin: string): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/login', {
    method: 'POST',
    body: { phone, pin },
  })
}

export async function register(name: string, phone: string, pin: string): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/register', {
    method: 'POST',
    body: { name, phone, pin },
  })
}

export async function logout(): Promise<void> {
  try {
    await request<{ success: boolean }>('/api/auth/logout', { method: 'POST' })
  } finally {
    await writeStoredSession(null)
  }
}

export async function fetchMe(): Promise<CurrentUser> {
  return request<CurrentUser>('/api/me')
}

export async function redeemVoucher(code: string): Promise<RedeemVoucherResponse> {
  return request<RedeemVoucherResponse>('/api/vouchers/redeem', {
    method: 'POST',
    body: { code },
  })
}

export async function activatePhysicalCard(code: string): Promise<ActivatePhysicalCardResponse> {
  return request<ActivatePhysicalCardResponse>('/api/physical-cards/activate', {
    method: 'POST',
    body: { code },
  })
}

export async function redeemReward(code: string): Promise<RedeemRewardResponse> {
  return request<RedeemRewardResponse>('/api/admin/redeem-reward', {
    method: 'POST',
    body: { code },
  })
}

export async function fetchCustomerCount(): Promise<number> {
  const data = await request<{ count: number }>('/api/admin/users/count')
  return data.count
}

/* -------------------------------------------------------------------------- */
/* Admin catalog management                                                   */
/* -------------------------------------------------------------------------- */

export async function createVoucherBatch(
  points: VoucherTier,
  quantity: number,
): Promise<CreateVoucherBatchResponse> {
  return request<CreateVoucherBatchResponse>('/api/admin/vouchers', {
    method: 'POST',
    body: { points, quantity },
  })
}

export async function fetchVoucherBatches(): Promise<VoucherBatchesResponse> {
  return request<VoucherBatchesResponse>('/api/admin/vouchers')
}

export async function fetchVoucherCardsByPoints(
  points: VoucherTier,
): Promise<VoucherCardsByPointsResponse> {
  return request<VoucherCardsByPointsResponse>(`/api/admin/vouchers/cards-by-points?points=${points}`)
}

export async function fetchVoucherCards(batchId: string): Promise<VoucherCardsResponse> {
  return request<VoucherCardsResponse>(`/api/admin/vouchers/${encodeURIComponent(batchId)}`)
}

export async function deleteClaimedVouchers(codes: string[]): Promise<DeleteVouchersResponse> {
  return request<DeleteVouchersResponse>('/api/admin/vouchers/delete', {
    method: 'POST',
    body: { codes },
  })
}

export async function createPhysicalCardBatch(
  quantity: number,
): Promise<CreatePhysicalCardsResponse> {
  return request<CreatePhysicalCardsResponse>('/api/admin/physical-cards', {
    method: 'POST',
    body: { quantity },
  })
}

export async function fetchPhysicalCardBatches(): Promise<PhysicalCardBatchesResponse> {
  return request<PhysicalCardBatchesResponse>('/api/admin/physical-cards')
}

export async function fetchPhysicalCardCards(
  batchId: string,
): Promise<PhysicalCardBatchCardsResponse> {
  return request<PhysicalCardBatchCardsResponse>(
    `/api/admin/physical-cards/${encodeURIComponent(batchId)}`,
  )
}

export async function hasStoredSession(): Promise<boolean> {
  return (await readStoredSession()) != null
}