import { CameraView, useCameraPermissions } from 'expo-camera'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, spacing } from '@/lib/theme'

/**
 * Thin wrapper around CameraView with barcode scanning.
 * Only render when `enabled` is true (the parent unmounts it on blur /
 * when scanning is off, so at most one camera view is ever mounted).
 */
export default function QrCamera({
  enabled,
  paused,
  onScanned,
}: {
  enabled: boolean
  paused: boolean
  onScanned: (raw: string) => void
}) {
  const [permission, requestPermission] = useCameraPermissions()

  if (!enabled || !permission) return null

  if (!permission.granted) {
    return (
      <View style={styles.permWrap}>
        <Text style={styles.permText}>Camera permission is needed to scan QR codes.</Text>
        <Pressable style={styles.permBtn} onPress={() => requestPermission()}>
          <Text style={styles.permBtnText}>Grant permission</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <CameraView
      style={StyleSheet.absoluteFill}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={paused ? undefined : ({ data }) => onScanned(data)}
    />
  )
}

const styles = StyleSheet.create({
  permWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.bg,
  },
  permText: { color: colors.textMuted, textAlign: 'center', maxWidth: 240 },
  permBtn: {
    backgroundColor: colors.amber,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  permBtnText: { color: colors.bg, fontWeight: '700' },
})