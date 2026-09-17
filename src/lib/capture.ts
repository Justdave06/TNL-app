import * as MediaLibrary from 'expo-media-library/legacy'
import { captureRef } from 'react-native-view-shot'

/**
 * Captures a React Native view as a PNG and saves it to the photo library.
 *
 * Uses the legacy subpath export: the newer (`expo-media-library`) module
 * targets the `ExpoMediaLibraryNext` native module, which Expo Go does not
 * bundle. The legacy native module is present in Expo Go, so saving keeps
 * working while testing without a development build.
 *
 * Returns the saved asset URI, or throws a user-friendly message on failure.
 */
export async function saveViewAsImage(
  viewRef: React.RefObject<React.Component | null>,
  fileName: string,
): Promise<string> {
  try {
    const current = await MediaLibrary.getPermissionsAsync(true)
    if (!current.granted) {
      const requested = await MediaLibrary.requestPermissionsAsync(true)
      if (!requested.granted && requested.canAskAgain === false) {
        throw new Error('Photo library permission was not granted')
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('permission')) throw error
    // Permission bridge may be unavailable in Expo Go on Android - saving via
    // MediaStore insert (scoped storage) does not require it on API 29+.
  }

  const uri = await captureRef(viewRef, {
    format: 'png',
    quality: 1,
    result: 'tmpfile',
  })
  const asset = await MediaLibrary.createAssetAsync(uri)
  await MediaLibrary.saveToLibraryAsync(asset.uri)
  return asset.uri
}