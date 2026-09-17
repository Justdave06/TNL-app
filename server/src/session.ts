import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import type { UserRole } from '../../src/lib/loyalty'

/**
 * Stateless signed-cookie sessions, so no session table or third-party module
 * is needed. The cookie is HMAC-SHA256 signed with `SESSION_SECRET` and carries
 * no secret data - just who the caller is. Ported 1:1 from the web backend.
 */

export interface SessionPayload {
  userId: string
  role: UserRole
  /** Issued-at, epoch ms. */
  iat: number
}

export const COOKIE_NAME = 'ramyun_session'
const MAX_AGE_MS = 60 * 60 * 24 * 7 * 1000

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function secret(): string {
  return process.env.SESSION_SECRET ?? 'tnl-dev-session-secret-change-me'
}

function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) cookies[name] = decodeURIComponent(value)
  }
  return cookies
}

export function startUserSession(res: Response, payload: SessionPayload): void {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  res.cookie(COOKIE_NAME, `${body}.${sign(body, secret())}`, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_MS,
    secure: false,
  })
}

export function readUserSession(req: Request): SessionPayload | null {
  const header = req.headers.cookie
  if (!header) return null

  const token = parseCookieHeader(header)[COOKIE_NAME]
  if (!token) return null

  const [body, signature] = token.split('.')
  if (!body || !signature) return null

  const expected = Buffer.from(sign(body, secret()))
  const received = Buffer.from(signature)
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload
    return payload?.userId ? payload : null
  } catch {
    return null
  }
}

export function endUserSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' })
}