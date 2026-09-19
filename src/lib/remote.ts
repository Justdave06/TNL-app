import AsyncStorage from '@react-native-async-storage/async-storage'
import { API_BASE_URL } from './config'
import type { CurrentUser } from './loyalty'
import type { SyncOp, SyncPushResponse, SyncSnapshot } from './syncTypes'

/**
 * Thin HTTP client for the TNL server.
 *
 * Sessions are HMAC-signed cookies. React Native's fetch cannot read the
 * `Set-Cookie` header, so the server also echoes the cookie in the login /
 * register JSON bodies (`authCookie`). The app stores the full `name=value`
 * string and re-sends it as the `Cookie` header, exactly like a browser.
 *
 * Every call throws `RemoteError`, so callers can tell "server said no"
 * (status > 0) apart from "no network" (status 0).
 */

const AUTH_COOKIE_KEY = 'tnl:session-cookie'
const SYNC_CRED_KEY = 'tnl:sync-cred'

const REQUEST_TIMEOUT_MS = 10_000

export class RemoteError extends Error {
  readonly status: number
  readonly data: unknown

  constructor(status: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RemoteError'
    this.status = status
    this.data = data
  }
}

/** True when the failure was a network problem, not an HTTP status. */
export function isNetworkError(error: unknown): boolean {
  return error instanceof RemoteError && error.status === 0
}

/* ------------------------------- Credentials ------------------------------ */

export async function getStoredAuthCookie(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(AUTH_COOKIE_KEY)
  } catch {
    return null
  }
}

export async function hasAuthCookie(): Promise<boolean> {
  return (await getStoredAuthCookie()) != null
}

export async function setStoredAuthCookie(cookie: string | null): Promise<void> {
  try {
    if (cookie) await AsyncStorage.setItem(AUTH_COOKIE_KEY, cookie)
    else await AsyncStorage.removeItem(AUTH_COOKIE_KEY)
  } catch {
    // Storage failures never break a request.
  }
}

export async function setSyncCred(phone: string, pin: string): Promise<void> {
  try {
    await AsyncStorage.setItem(SYNC_CRED_KEY, JSON.stringify({ phone, pin }))
  } catch {
    // Best-effort: without cred we just need a fresh login to sync.
  }
}

export async function getSyncCred(): Promise<{ phone: string; pin: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_CRED_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { phone?: string; pin?: string }
    return parsed.phone && parsed.pin ? { phone: parsed.phone, pin: parsed.pin } : null
  } catch {
    return null
  }
}

export async function clearSyncCred(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SYNC_CRED_KEY)
  } catch {
    // Best-effort.
  }
}

/* -------------------------------- Transport ------------------------------- */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  anonymous?: boolean
}

async function request(options: RequestOptions, path: string): Promise<{ status: number; data: unknown }> {
  const cookie = options.anonymous ? null : await getStoredAuthCookie()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
  } catch {
    throw new RemoteError(0, 'You are offline - this needs an internet connection')
  } finally {
    clearTimeout(timer)
  }

  const data = await parseBody(response)
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string'
        ? ((data as { message: string }).message as string)
        : `The server could not complete that request (${response.status})`
    throw new RemoteError(response.status, message, data)
  }
  return { status: response.status, data }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function json<T>(options: RequestOptions, path: string): Promise<T> {
  const { data } = await request(options, path)
  return data as T
}

/* ------------------------------ Auth (online) ----------------------------- */

/** The login/register bodies carry the signed cookie so fetch can store it. */
export type AuthBody = CurrentUser & { authCookie?: string }

export async function authorize(phone: string, pin: string): Promise<AuthBody> {
  const result = await json<AuthBody>({ method: 'POST', body: { phone, pin } }, '/api/auth/login')
  if (result.authCookie) await setStoredAuthCookie(result.authCookie)
  return result
}

export async function registerRemote(name: string, phone: string, pin: string): Promise<AuthBody> {
  const result = await json<AuthBody>({ method: 'POST', body: { name, phone, pin } }, '/api/auth/register')
  if (result.authCookie) await setStoredAuthCookie(result.authCookie)
  return result
}

export async function revokeSession(): Promise<void> {
  try {
    await request({ method: 'POST' }, '/api/auth/logout')
  } catch {
    // Best-effort server logout; the local session is what matters.
  } finally {
    await setStoredAuthCookie(null)
  }
}

/* ------------------------------- Sync routes ------------------------------ */

export async function pushOps(ops: SyncOp[]): Promise<SyncPushResponse> {
  return json<SyncPushResponse>({ method: 'POST', body: { ops } }, '/api/sync/push')
}

export async function pullSnapshot(): Promise<SyncSnapshot> {
  return json<SyncSnapshot>({ method: 'GET' }, '/api/sync/pull')
}

/* ---------------------------- Online-only writes --------------------------- */

export async function postRedeem(code: string): Promise<unknown> {
  return json({ method: 'POST', body: { code } }, '/api/vouchers/redeem')
}

export async function postActivate(code: string): Promise<unknown> {
  return json({ method: 'POST', body: { code } }, '/api/physical-cards/activate')
}

export async function postAdmin(path: string, body: unknown): Promise<unknown> {
  return json({ method: 'POST', body }, `/api/admin${path}`)
}

export async function getAdmin(path: string): Promise<unknown> {
  return json({ method: 'GET' }, `/api/admin${path}`)
}