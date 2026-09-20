# Supabase Migration Plan for TNL App

## Overview

Migrate the TNL app's Express + JSON file backend to Supabase (PostgreSQL + Edge Functions), using the **exact same schema and RPC functions** from `my-business-web` which already implements the identical loyalty system.

---

## Current State (TNL App)

| Component | Technology |
|-----------|------------|
| Mobile App | Expo + React Native + Expo Router |
| Backend | Express.js + TypeScript (`server/src/index.ts`) |
| Database | JSON files (`server/.data/*.json`) |
| Auth | HMAC-signed cookies + PIN hashing (scrypt) |
| Sync | Custom offline-first protocol (`/api/sync/*`) |
| API URL | Cloudflare tunnel (preview) / placeholder (production) |

---

## Target State (Supabase)

| Component | Technology |
|-----------|------------|
| Mobile App | Expo + React Native (minimal changes) |
| Database | Supabase PostgreSQL (managed) |
| Auth | Supabase Auth (email/phone OTP) or keep PIN + custom JWT |
| Business Logic | PostgreSQL RPC functions (atomic, in-database) |
| Realtime | Built-in subscriptions (optional) |
| Storage | Supabase Storage (for card images) |
| Edge Functions | Deno/TypeScript for custom logic |

---

## Migration Strategy

### Phase 1: Supabase Project Setup (30 min)

1. **Create Supabase project** at supabase.com
2. **Apply schema** from `my-business-web/supabase/schema.sql`
   ```bash
   # Option A: Supabase CLI
   supabase db push
   # Option B: Paste SQL in Supabase Dashboard > SQL Editor
   ```
3. **Get credentials**:
   - Project URL: `https://<ref>.supabase.co`
   - Service Role Key: `supabase_service_role_key` (server-only)
   - Anon Key: `supabase_anon_key` (client-safe)

### Phase 2: Backend Migration (Express → Supabase)

#### Option A: Thin Adapter (Recommended - minimal changes)
Keep Express server, swap JSON → Supabase in `server/src/db.ts`:

```typescript
// server/src/db.ts - add Supabase client
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)

// Every function: if (supabase) { use RPC } else { use JSON }
```

**Changes needed in `server/src/db.ts`:**
- Add `supabase()` getter (pattern from `my-business-web/server/utils/db.ts`)
- Wrap each exported function: Supabase RPC first, JSON fallback
- Keep same TypeScript interfaces (already match)
- Use existing RPCs: `redeem_voucher_card`, `redeem_reward_points`

#### Option B: Remove Express, Use Supabase Directly (Cleaner long-term)
- Mobile app calls Supabase PostgREST + RPCs directly
- Auth via Supabase Auth (OTP) or custom JWT
- Eliminates server hosting entirely

**Trade-off**: Requires updating `src/lib/api.ts` and `src/lib/remote.ts` significantly.

---

### Phase 3: Mobile App Updates

#### If Option A (Thin Adapter):
- **Minimal changes**: Only `eas.json` production URL → Supabase project URL
- `src/lib/remote.ts` and `src/lib/api.ts` unchanged
- Sync protocol works as-is

#### If Option B (Direct):
- Replace `src/lib/remote.ts` with `@supabase/supabase-js` client
- Update `src/lib/api.ts` to call Supabase directly
- Migrate auth to Supabase Auth (OTP) or implement custom JWT verification
- Sync protocol can be simplified (PostgREST + Realtime)

---

## Key Files to Reference (from my-business-web)

| File | Purpose |
|------|---------|
| `supabase/schema.sql` | Complete PostgreSQL schema + RPC functions |
| `server/utils/db.ts` | Dual-backend pattern (JSON ↔ Supabase) |
| `server/api/vouchers/redeem.post.ts` | Example API route using `redeemVoucher` |
| `server/api/auth/login.post.ts` | Auth pattern |
| `shared/loyalty.ts` | Shared TypeScript types (already match TNL) |

---

## Schema Mapping (Already Aligned)

| TNL JSON | Supabase Table | Notes |
|----------|----------------|-------|
| `users.json` | `public.users` | Add `created_at`, UUID PK |
| `point-awards.json` | `public.point_awards` | Same columns |
| `vouchers.json` | `public.vouchers` | `code` is PK, add `batch_id` UUID |
| `physical-cards.json` | **Not in schema** | Add if needed (separate table) |

**Note**: Physical cards table missing from Supabase schema. Need to add:
```sql
create table public.physical_cards (
  kode text primary key,
  batch_id uuid not null,
  created_at timestamptz not null default now(),
  activated_by uuid references public.users(id) on delete set null,
  activated_at timestamptz
);
create index on public.physical_cards (batch_id);
```

And RPC: `activate_physical_card(p_kode text, p_user_id uuid)`

---

## Environment Variables

### Server (Express)
```env
# .env (server/)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Mobile App (EAS)
```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value "https://<ref>.supabase.co"
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## Validation Checklist

- [ ] Supabase project created, schema applied
- [ ] Physical cards table + RPC added
- [ ] Express server updated with Supabase client
- [ ] All `db.ts` functions work with Supabase (test locally)
- [ ] Preview build works with Supabase backend
- [ ] Production build works with Supabase backend
- [ ] Sync protocol (`/api/sync/*`) works with Supabase
- [ ] Auth (login/register/logout) works
- [ ] Admin routes (vouchers, physical cards) work
- [ ] Point expiry (7 days) works via `expires_at` column
- [ ] Balance cap (50) enforced in RPC
- [ ] Seed data loads (admin user, demo customers)

---

## Rollback Plan

- Keep JSON backend as fallback in `db.ts` (current pattern)
- Deploy Express to any host (Render, Railway, Fly.io) as backup
- Feature flag: `SUPABASE_URL` unset → uses JSON

---

## Open Questions

1. **Auth approach**: Keep PIN + cookie, or migrate to Supabase Auth (OTP)?
2. **Physical cards**: Add to Supabase schema, or keep in JSON?
3. **Sync protocol**: Keep custom `/api/sync/*`, or use Supabase Realtime?
4. **Hosting**: Deploy Express adapter, or go serverless with Edge Functions?
5. **Migration timing**: Big bang or gradual (dual-write period)?

---

## Recommended Path

**Start with Option A (Thin Adapter)** - lowest risk, fastest to validate:
1. Apply Supabase schema + physical cards table
2. Update `server/src/db.ts` with Supabase client (copy pattern from my-business-web)
3. Test locally with `SUPABASE_URL` set
4. Deploy Express to any host (or keep local tunnel)
5. Once stable, decide on Option B for v2