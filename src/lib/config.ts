/**
 * API base URL for the TNL backend.
 *
 * The app talks to TNL's own standalone API server (`server/` in this repo,
 * started with `npm run server`). Point EXPO_PUBLIC_API_URL at a reachable host:
 *
 *   - Android emulator:  http://10.0.2.2:3000  (host loopback, no tunnel)
 *   - iOS simulator:     http://localhost:3000
 *   - Physical device:   the HTTPS tunnel URL from `npm run tunnel`, or the
 *     deployed Render URL once the server is live.
 *
 * Example: put `EXPO_PUBLIC_API_URL=https://your-tunnel.trycloudflare.com` in a
 * .env file (Expo inlines EXPO_PUBLIC_* vars into the bundle).
 */
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000'