import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'
import type { CurrentUser } from './loyalty'
import type { SyncOp, SyncOpResult, SyncPushResponse, SyncSnapshot } from './syncTypes'

const SESSION_STORAGE_KEY = 'tnl:session-user'

let supabaseClient: SupabaseClient | null = null

function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return supabaseClient
}

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

export function isNetworkError(error: unknown): boolean {
  return error instanceof RemoteError && error.status === 0
}

async function getStoredUserId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

export async function setStoredAuthCookie(cookie: string | null): Promise<void> {
  try {
    if (cookie) await AsyncStorage.setItem(SESSION_STORAGE_KEY, cookie.split('=')[0])
    else await AsyncStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Storage failures never break a request.
  }
}

async function setStoredUserId(userId: string | null): Promise<void> {
  try {
    if (userId) await AsyncStorage.setItem(SESSION_STORAGE_KEY, userId)
    else await AsyncStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Storage failures never break a request.
  }
}

export async function hasAuthCookie(): Promise<boolean> {
  return (await getStoredUserId()) != null
}

export async function hasStoredSession(): Promise<boolean> {
  const userId = await getStoredUserId()
  if (!userId) return false
  return (await getSupabase().from('users').select('id').eq('id', userId).maybeSingle()).data != null
}

export async function setSyncCred(phone: string, pin: string): Promise<void> {
  try {
    await AsyncStorage.setItem('tnl:sync-cred', JSON.stringify({ phone, pin }))
  } catch {
    // Best-effort.
  }
}

export async function getSyncCred(): Promise<{ phone: string; pin: string } | null> {
  try {
    const raw = await AsyncStorage.getItem('tnl:sync-cred')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { phone?: string; pin?: string }
    return parsed.phone && parsed.pin ? { phone: parsed.phone, pin: parsed.pin } : null
  } catch {
    return null
  }
}

export async function clearSyncCred(): Promise<void> {
  try {
    await AsyncStorage.removeItem('tnl:sync-cred')
  } catch {
    // Best-effort.
  }
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export type AuthBody = CurrentUser

export async function authorize(phone: string, pin: string): Promise<AuthBody> {
  const { data, error } = await getSupabase().rpc('verify_login', { p_phone: phone, p_pin: pin })
  if (error) {
    throw new RemoteError(401, error.message ?? 'Invalid phone number or PIN')
  }
  const result = data as { ok: boolean; error?: string; user?: CurrentUser }
  if (!result.ok || !result.user) {
    throw new RemoteError(401, result.error ?? 'Invalid phone number or PIN')
  }
  await setStoredUserId(result.user.id)
  return result.user
}

export async function registerRemote(name: string, phone: string, pin: string): Promise<AuthBody> {
  const { data, error } = await getSupabase().rpc('register_user', { p_name: name, p_phone: phone, p_pin: pin })
  if (error) {
    throw new RemoteError(500, error.message ?? 'Registration failed')
  }
  const result = data as { ok: boolean; error?: string; user?: CurrentUser }
  if (!result.ok || !result.user) {
    throw new RemoteError(409, result.error ?? 'Registration failed')
  }
  await setStoredUserId(result.user.id)
  return result.user
}

export async function revokeSession(): Promise<void> {
  await setStoredUserId(null)
}

/* -------------------------------------------------------------------------- */
/* Sync routes                                                                */
/* -------------------------------------------------------------------------- */

export async function pushOps(ops: SyncOp[]): Promise<SyncPushResponse> {
  const { data, error } = await getSupabase().rpc('apply_sync_ops', { p_ops: ops })
  if (error) {
    throw new RemoteError(500, error.message ?? 'Sync push failed')
  }
  const result = data as { results: SyncOpResult[]; serverTime: number }
  return { results: result.results, serverTime: result.serverTime }
}

export async function pullSnapshot(): Promise<SyncSnapshot> {
  const userId = await getStoredUserId()
  if (!userId) {
    throw new RemoteError(401, 'Please sign in')
  }
  const { data: user, error: userError } = await getSupabase().from('users').select('role').eq('id', userId).single()
  if (userError || !user) {
    throw new RemoteError(401, 'Session is no longer valid')
  }

  const { data, error } = await getSupabase().rpc('build_snapshot', { p_role: user.role, p_user_id: userId })
  if (error) {
    throw new RemoteError(500, error.message ?? 'Sync pull failed')
  }
  return data as SyncSnapshot
}

/* ---------------------------- Online-only writes --------------------------- */

export async function postRedeem(code: string): Promise<unknown> {
  const userId = await getStoredUserId()
  if (!userId) throw new RemoteError(401, 'Please sign in')
  const { data, error } = await getSupabase().rpc('redeem_voucher_card', { p_code: code, p_user_id: userId })
  if (error) {
    if (error.code === 'P0001') {
      const msg = error.message ?? ''
      if (msg.includes('already_redeemed')) throw new RemoteError(409, 'That card has already been used')
      if (msg.includes('unknown_code')) throw new RemoteError(404, 'That kode was not recognised')
      if (msg.includes('balance_cap')) throw new RemoteError(409, msg)
    }
    throw new RemoteError(500, error.message ?? 'Redemption failed')
  }
  const row = (data as { points: number; new_balance: number; expires_at: string }[] | null)?.[0]
  if (!row) throw new RemoteError(404, 'That kode was not recognised or has already been used')
  return {
    success: true,
    code,
    pointsAdded: row.points,
    newBalance: row.new_balance,
    expiresAt: new Date(row.expires_at).getTime(),
  }
}

export async function postActivate(code: string): Promise<unknown> {
  const userId = await getStoredUserId()
  if (!userId) throw new RemoteError(401, 'Please sign in')
  const { data, error } = await getSupabase().rpc('activate_physical_card', { p_kode: code, p_user_id: userId })
  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('already_activated')) throw new RemoteError(409, 'That card has already been activated')
    if (msg.includes('unknown_kode')) throw new RemoteError(404, 'That card kode was not recognised')
    throw new RemoteError(500, error.message ?? 'Activation failed')
  }
  return {
    success: true,
    code,
    activatedAt: new Date(data as string).getTime(),
  }
}

export async function postAdmin(path: string, body: unknown): Promise<unknown> {
  const userId = await getStoredUserId()
  if (!userId) throw new RemoteError(401, 'Please sign in')
  const { data: user } = await getSupabase().from('users').select('role').eq('id', userId).single()
  if (!user || user.role !== 'admin') {
    throw new RemoteError(403, 'Admin access required')
  }

  const supabase = getSupabase()
  let result: unknown

  if (path === '/vouchers') {
    const b = body as { points: number; quantity: number }
    const { data, error } = await supabase.rpc('create_voucher_batch', { p_points: b.points, p_quantity: b.quantity })
    if (error) throw new RemoteError(500, error.message ?? 'Failed to create vouchers')
    result = data
  } else if (path === '/physical-cards') {
    const b = body as { quantity: number }
    const { data, error } = await supabase.rpc('create_physical_card_batch', { p_quantity: b.quantity })
    if (error) throw new RemoteError(500, error.message ?? 'Failed to create physical cards')
    result = data
  } else if (path === '/vouchers/delete') {
    const b = body as { codes: string[] }
    const { data, error } = await supabase.rpc('delete_claimed_vouchers', { p_codes: b.codes })
    if (error) throw new RemoteError(500, error.message ?? 'Failed to delete vouchers')
    result = data
  } else if (path === '/vouchers/delete-tier') {
    const b = body as { points: number }
    const { data, error } = await supabase.rpc('delete_unclaimed_vouchers', { p_points: b.points })
    if (error) throw new RemoteError(500, error.message ?? 'Failed to delete the card pool')
    result = data
  } else if (path === '/physical-cards/delete-batch') {
    const b = body as { batchId: string }
    const { data, error } = await supabase.rpc('delete_unactivated_physical_cards', { p_batch_id: b.batchId })
    if (error) throw new RemoteError(500, error.message ?? 'Failed to delete the batch')
    result = data
  } else {
    throw new RemoteError(400, `Unknown admin path: ${path}`)
  }

  return result
}

export async function getAdmin(path: string): Promise<unknown> {
  const userId = await getStoredUserId()
  if (!userId) throw new RemoteError(401, 'Please sign in')
  const { data: user } = await getSupabase().from('users').select('role').eq('id', userId).single()
  if (!user || user.role !== 'admin') {
    throw new RemoteError(403, 'Admin access required')
  }

  const supabase = getSupabase()

  if (path === '/vouchers') {
    const { data, error } = await supabase.rpc('list_voucher_batches')
    if (error) throw new RemoteError(500, error.message ?? 'Failed to load vouchers')
    return data
  }
  if (path.startsWith('/vouchers/cards-by-points')) {
    const params = new URLSearchParams(path.split('?')[1])
    const points = Number(params.get('points'))
    const { data, error } = await supabase.rpc('get_voucher_cards_by_points', { p_points: points })
    if (error) throw new RemoteError(500, error.message ?? 'Failed to load cards')
    return data
  }
  if (path.startsWith('/vouchers/')) {
    const batchId = path.replace('/vouchers/', '')
    const { data, error } = await supabase.from('vouchers').select('*').eq('batch_id', batchId)
    if (error) throw new RemoteError(500, error.message ?? 'Failed to load cards')
    return data
  }
  if (path === '/physical-cards') {
    const { data, error } = await supabase.rpc('list_physical_card_batches')
    if (error) throw new RemoteError(500, error.message ?? 'Failed to load physical cards')
    return data
  }
  if (path.startsWith('/physical-cards/')) {
    const batchId = path.replace('/physical-cards/', '')
    const { data, error } = await supabase.from('physical_cards').select('*').eq('batch_id', batchId)
    if (error) throw new RemoteError(500, error.message ?? 'Failed to load cards')
    return data
  }

  throw new RemoteError(400, `Unknown admin path: ${path}`)
}

export async function fetchCustomerCount(): Promise<number> {
  const { data, error } = await getSupabase().rpc('count_customers')
  if (error) throw new RemoteError(500, error.message ?? 'Failed to count customers')
  return (data as { count: number }).count ?? 0
}

export async function listVoucherBatches(): Promise<unknown> {
  const { data, error } = await getSupabase().rpc('list_voucher_batches')
  if (error) throw new RemoteError(500, error.message ?? 'Failed to load voucher batches')
  return data
}

export async function listPhysicalCardBatches(): Promise<unknown> {
  const { data, error } = await getSupabase().rpc('list_physical_card_batches')
  if (error) throw new RemoteError(500, error.message ?? 'Failed to load physical card batches')
  return data
}

export async function fetchVoucherCardsByPoints(points: number): Promise<unknown> {
  const { data, error } = await getSupabase().rpc('get_voucher_cards_by_points', { p_points: points })
  if (error) throw new RemoteError(500, error.message ?? 'Failed to load voucher cards')
  return data
}

export async function fetchPhysicalCardCards(batchId: string): Promise<unknown> {
  const { data, error } = await getSupabase().from('physical_cards').select('*').eq('batch_id', batchId)
  if (error) throw new RemoteError(500, error.message ?? 'Failed to load physical cards')
  return data
}
