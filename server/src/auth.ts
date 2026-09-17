import type { Request } from 'express'
import { readUserSession } from './session'
import { getUserById, type UserRow } from './db'

/** Error carrying an HTTP status, rendered by the Express error middleware. */
export class AppError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AppError'
    this.status = status
  }
}

export function httpError(status: number, message: string): AppError {
  return new AppError(status, message)
}

/** Resolves the signed-in user or throws 401. */
export async function requireUser(req: Request): Promise<UserRow> {
  const session = readUserSession(req)
  if (!session) throw httpError(401, 'Please sign in')
  const user = await getUserById(session.userId)
  if (!user) throw httpError(401, 'Session is no longer valid - please sign in again')
  return user
}

/** Resolves the signed-in user and enforces the admin role, or throws. */
export async function requireAdmin(req: Request): Promise<UserRow> {
  const user = await requireUser(req)
  if (user.role !== 'admin') throw httpError(403, 'Admin access required')
  return user
}