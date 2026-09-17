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

const CLOUDFLARED_WIN32 = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
const command = process.platform === 'win32' ? CLOUDFLARED_WIN32 : 'cloudflared'

const child = spawn(command, ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Failed to start ${command}. Is cloudflared installed?`, error.message)
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 0))