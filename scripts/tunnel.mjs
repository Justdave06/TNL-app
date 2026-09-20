import { spawn } from 'node:child_process'

/**
 * Quick Tunnel for testing the app on a physical phone.
 *
 * Proxies the local standalone API server (server/, default :3000) through
 * cloudflared and prints a public HTTPS URL. Copy that URL into .env as
 * EXPO_PUBLIC_API_URL, restart `expo start --clear`, and the phone can reach
 * the server on your PC.
 */

const PORT = process.env.PORT ?? '3000'

const command = process.platform === 'win32' ? 'npx' : 'cloudflared'
const args = process.platform === 'win32'
  ? ['cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`]
  : ['tunnel', '--url', `http://localhost:${PORT}`]

const child = spawn(command, args, {
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Failed to start ${command}. Is cloudflared installed?`, error.message)
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 0))