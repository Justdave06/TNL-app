import * as Crypto from 'expo-crypto'

/**
 * PIN hashing for the fully offline build.
 *
 * The server hashes PINs with node's scrypt, which is unavailable in React
 * Native. The offline app stores its own database on-device, so it uses a
 * salted SHA-256 digest instead, in the same `scheme$salt$derived` shape:
 * `sha256$<salt>$<hex-digest>`.
 */

const SCHEME = 'sha256'

function digest(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`)
}

/** Hash a PIN for storage: `sha256$<salt>$<derived>`. */
export async function hashPin(pin: string): Promise<string> {
  const salt = Crypto.randomUUID()
  const derived = await digest(pin, salt)
  return `${SCHEME}$${salt}$${derived}`
}

export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const [scheme, salt, derived] = storedHash.split('$')
  if (scheme !== SCHEME || !salt || !derived) return false
  const actual = await digest(pin, salt)
  return actual === derived
}