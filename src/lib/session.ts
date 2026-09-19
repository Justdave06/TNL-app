import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Local sign-in state (the on-device stand-in for the server's signed cookie).
 * A plain stored user id: role checks still run against the local user row.
 */

export const SESSION_STORAGE_KEY = 'tnl:session-user'

export async function readSessionUserId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

export async function writeSessionUserId(userId: string | null): Promise<void> {
  try {
    if (userId) await AsyncStorage.setItem(SESSION_STORAGE_KEY, userId)
    else await AsyncStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Storage failures should never break a request.
  }
}