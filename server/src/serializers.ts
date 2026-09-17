import type { CurrentUser } from '../../src/lib/loyalty'
import { getLivePointsInfo, hasActivatedPhysicalCard, type UserRow } from './db'

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