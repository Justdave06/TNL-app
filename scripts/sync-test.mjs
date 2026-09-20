/**
 * End-to-end sync protocol test.
 *
 * Boots the standalone server on a throwaway DATA_DIR + PORT, then drives the
 * exact HTTP surface a device would use:
 *
 *   1. admin signs in and mints a points card
 *   2. a new customer "registers offline" via the push queue
 *   3. the customer claims the printed code (offline-style) -> award
 *   4. an admin "scans offline" (spend_awards) -> points deducted
 *   5. a second admin's scan of the same QR is REJECTED
 *   6. replays are idempotent (no double users, no double awards)
 *
 * Exits 0 on success, 1 on failure.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_DIR = join(ROOT, 'server')
const PORT = 4567 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'tnl-sync-test-'))

let failed = 0
function check(label, condition, extra = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failed += 1
  console.log(`  [${mark}] ${label}${extra ? ` (${extra})` : ''}`)
}

function cookieFrom(res) {
  const set = res.headers.get('set-cookie')
  if (!set) return null
  return set.split(';')[0]
}

async function api(path, { method = 'GET', cookie, body } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, headers: res.headers, data, cookie: cookieFrom(res) }
}

const server = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: 'test-secret' },
  stdio: 'ignore',
})

async function waitForBoot() {
  const limit = Date.now() + 30_000
  while (Date.now() < limit) {
    try {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '1', pin: '1' }),
      })
      if (res.status === 401) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server never booted')
}

async function main() {
  console.log(`Spawning server on :${PORT} (data: ${DATA_DIR})`)
  await waitForBoot()

  /* ---- 1. admin login + mint a card ---- */
  console.log('\n1. admin login + voucher mint')
  const admin = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '09518050546', pin: '0000' },
  })
  check('admin login 200', admin.status === 200)
  const adminCookie = admin.cookie
  check('admin gets a cookie', !!adminCookie)

  const mint = await api('/api/admin/vouchers', {
    method: 'POST',
    cookie: adminCookie,
    body: { points: 3, quantity: 2 },
  })
  check('mint voucher 200', mint.status === 200)
  const codes = (mint.data?.cards ?? []).map((card) => card.code)
  check('minted two codes', codes.length === 2, codes.join(', '))

  /* ---- 1b. the login response echoes the session cookie for RN fetch ---- */
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '09518050546', pin: '0000' },
  })
  check('login returns authCookie in body', typeof login.data?.authCookie === 'string')

  /* ---- 2. new customer "registers offline" via push queue ---- */
  console.log('\n2. offline register via push queue')
  const customerId = randomUUID()
  const deviceA = 'device-member-a'
  const regOp = {
    opId: randomUUID(),
    type: 'register_user',
    createdAt: Date.now(),
    deviceId: deviceA,
    payload: { userId: customerId, name: 'Sync Tester', phone: '01088889999', pin: '7777', refCode: 'SYNC1' },
  }
  const reg = await api('/api/sync/push', { method: 'POST', body: { ops: [regOp] } })
  const registerResult = reg.data?.results?.[0]
  check('register op accepted', reg.status === 200 && registerResult?.ok === true)
  const memberCookie = registerResult?.state?.authCookie
  check('register returns an auth cookie', typeof memberCookie === 'string')

  /* ---- 3. customer claims two printed cards offline -> 6 points ---- */
  console.log('\n3. claim printed cards via push queue')
  const awardId1 = randomUUID()
  const awardId2 = randomUUID()
  const claimOps = codes.map((code, index) => ({
    opId: randomUUID(),
    type: 'redeem_voucher',
    createdAt: Date.now(),
    deviceId: deviceA,
    payload: {
      userId: customerId,
      code,
      awardId: index === 0 ? awardId1 : awardId2,
      awardedAt: Date.now(),
    },
  }))
  const claim = await api('/api/sync/push', { method: 'POST', cookie: memberCookie, body: { ops: claimOps } })
  const claimAllAccepted = (claim.data?.results ?? []).every((res) => res?.ok === true)
  check('both claims accepted', claim.status === 200 && claimAllAccepted)
  if (!claimAllAccepted) console.log('    claims:', JSON.stringify(claim.data))

  /* ---- 4. admin "scans offline" -> spends both awards ---- */
  console.log('\n4. admin offline scan (spend_awards)')
  const spendOp = {
    opId: randomUUID(),
    type: 'spend_awards',
    createdAt: Date.now(),
    deviceId: 'device-admin-1',
    payload: { adminUserId: 'admin', userId: customerId, awardIds: [awardId1, awardId2], capturedAt: Date.now() },
  }
  const spend = await api('/api/sync/push', { method: 'POST', cookie: adminCookie, body: { ops: [spendOp] } })
  check('spend accepted', spend.status === 200 && spend.data?.results?.[0]?.ok === true)
  if (!(spend.data?.results?.[0]?.ok === true)) console.log('    spend:', JSON.stringify(spend.data))
  check('remaining balance 0', spend.data?.results?.[0]?.state?.remainingBalance === 0)

  /* ---- 5. second admin scan of the same QR is rejected ---- */
  console.log('\n5. conflicting offline scan is rejected')
  const conflictOp = {
    opId: randomUUID(),
    type: 'spend_awards',
    createdAt: Date.now(),
    deviceId: 'device-admin-2',
    payload: { adminUserId: 'admin', userId: customerId, awardIds: [awardId1, awardId2], capturedAt: Date.now() },
  }
  const conflict = await api('/api/sync/push', { method: 'POST', cookie: adminCookie, body: { ops: [conflictOp] } })
  const conflictResult = conflict.data?.results?.[0]
  check('conflict rejected', conflict.status === 200 && conflictResult?.ok === false)
  check('reject reason already_spent', conflictResult?.reason === 'already_spent')

  /* ---- 6. replays are idempotent ---- */
  console.log('\n6. idempotent replays')
  const replay = await api('/api/sync/push', { method: 'POST', body: { ops: [regOp] } })
  check('re-register replay uses journal', replay.status === 200 && replay.data?.results?.[0]?.ok === true)
  const pull = await api('/api/sync/pull', { cookie: memberCookie })
  const users = pull.data?.users ?? []
  check('pull returns one user', users.length === 1)
  check('no duplicate phone from replay', users.filter((u) => u.phone === '01088889999').length === 1)
  const memberAward = (pull.data?.awards ?? []).find((a) => a.id === awardId1)
  check('award present and spent', memberAward != null && memberAward.spent_at != null)

  /* ---- 7. same code claimed by another device -> rejected ---- */
  console.log('\n7. double-claim of the same printed code')
  const otherUser = randomUUID()
  const otherReg = await api('/api/sync/push', {
    method: 'POST',
    body: {
      ops: [
        {
          opId: randomUUID(),
          type: 'register_user',
          createdAt: Date.now(),
          deviceId: 'device-member-b',
          payload: { userId: otherUser, name: 'Second Customer', phone: '01088880002', pin: '1234', refCode: 'SYNC2' },
        },
      ],
    },
  })
  const otherRegCookie = otherReg.data?.results?.[0]?.state?.authCookie
  check('second customer registered', typeof otherRegCookie === 'string')
  const otherClaim = await api('/api/sync/push', {
    method: 'POST',
    cookie: otherRegCookie,
    body: {
      ops: [
        {
          opId: randomUUID(),
          type: 'redeem_voucher',
          createdAt: Date.now(),
          deviceId: 'device-member-b',
          payload: { userId: otherUser, code: codes[0], awardId: randomUUID(), awardedAt: Date.now() },
        },
      ],
    },
  })
  const otherResult = otherClaim.data?.results?.[0]
  check('second claim rejected', otherClaim.status === 200 && otherResult?.ok === false)
  check('reject reason already_redeemed', otherResult?.reason === 'already_redeemed')

  console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : `${failed} TEST(S) FAILED`}`)
  return failed === 0
}

main()
  .then((ok) => {
    server.kill()
    rmSync(DATA_DIR, { recursive: true, force: true })
    process.exit(ok ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    server.kill()
    rmSync(DATA_DIR, { recursive: true, force: true })
    process.exit(1)
  })