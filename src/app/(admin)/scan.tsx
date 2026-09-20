import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import * as React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { Audio } from 'expo-av'
import QrCamera from '@/components/qr-scanner'
import { Card, PrimaryButton } from '@/components/ui'
import * as api from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { parsePhysicalCardQrPayload, parseRewardPayload } from '@/lib/loyalty'
import { colors, spacing } from '@/lib/theme'
import { useToast } from '@/lib/toast'
import type { RedeemRewardResponse } from '@/lib/loyalty'

/** Server message when the balance is below the claim minimum. */
const NEEDS_POINTS_PATTERN = /needs at least \d+ points|insufficient_points/i

interface ScanResult {
  kind: 'success' | 'error'
  title: string
  detail: string
}

/** How long a scan result stays up before the camera auto-resumes. */
const SUCCESS_HOLD_MS = 2500
const ERROR_HOLD_MS = 5000
const DUPLICATE_WINDOW_MS = 5000

export default function ScanScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const { push } = useToast()

  const [scanning, setScanning] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [result, setResult] = React.useState<ScanResult | null>(null)
  const [manualUserId, setManualUserId] = React.useState('')

  // Sound + haptics
  const [successSound, setSuccessSound] = React.useState<Audio.Sound | null>(null)
  const [errorSound, setErrorSound] = React.useState<Audio.Sound | null>(null)

  React.useEffect(() => {
    (async () => {
      try {
        const { sound: s1 } = await Audio.Sound.createAsync(require('@/assets/sounds/success.mp3'))
        const { sound: s2 } = await Audio.Sound.createAsync(require('@/assets/sounds/error.mp3'))
        setSuccessSound(s1)
        setErrorSound(s2)
      } catch {
        // Sounds optional - haptics will still work
      }
    })()
    return () => {
      successSound?.unloadAsync()
      errorSound?.unloadAsync()
    }
  }, [])

  function playSuccess(): void {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
    successSound?.replayAsync()
  }

  function playError(): void {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
    errorSound?.replayAsync()
  }

  const autoResumeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastDecodedRef = React.useRef('')
  const lastDecodedAtRef = React.useRef(0)

  const clearAutoResume = React.useCallback(() => {
    if (autoResumeTimer.current) {
      clearTimeout(autoResumeTimer.current)
      autoResumeTimer.current = null
    }
  }, [])

  React.useEffect(() => () => clearAutoResume(), [clearAutoResume])

  // Only staff may run the cashier scanner.
  React.useEffect(() => {
    if (user && user.role !== 'admin') router.replace('/')
  }, [user, router])

  function scheduleAutoResume(delayMs: number): void {
    clearAutoResume()
    autoResumeTimer.current = setTimeout(() => {
      autoResumeTimer.current = null
      if (!submitting && scanning) resumeScanning()
    }, delayMs)
  }

  function resumeScanning(): void {
    clearAutoResume()
    setResult(null)
    lastDecodedRef.current = ''
  }

  function stopScanning(): void {
    clearAutoResume()
    setScanning(false)
    setResult(null)
    lastDecodedRef.current = ''
  }

  async function redeem(code: string): Promise<void> {
    if (submitting) return
    setSubmitting(true)

    try {
      const response: RedeemRewardResponse = await api.redeemReward(code)
      const detail = response.pending
        ? `${response.customerName} spent ${response.pointsSpent} points - refund if the server rejects this on the next sync.`
        : `${response.customerName} spent ${response.pointsSpent} points and now has ${response.remainingPoints}.`
      setResult({
        kind: 'success',
        title: `${response.discountApplied} discount applied`,
        detail,
      })
      push(`${response.discountApplied} discount applied for ${response.customerName}`, 'success')
      playSuccess()
      scheduleAutoResume(SUCCESS_HOLD_MS)
    } catch (error) {
      const message = describeError(error)
      setResult(
        NEEDS_POINTS_PATTERN.test(message)
          ? { kind: 'error', title: 'Not enough points', detail: message }
          : { kind: 'error', title: 'Redemption failed', detail: message },
      )
      playError()
      scheduleAutoResume(ERROR_HOLD_MS)
    } finally {
      setSubmitting(false)
    }
  }

  function onDecoded(decodedText: string): void {
    const now = Date.now()
    if (decodedText === lastDecodedRef.current && now - lastDecodedAtRef.current < DUPLICATE_WINDOW_MS) return
    lastDecodedRef.current = decodedText
    lastDecodedAtRef.current = now

    const isRewardQr = parseRewardPayload(decodedText) !== null
    const isCardQr = parsePhysicalCardQrPayload(decodedText) !== null
    if (!isRewardQr && !isCardQr) {
      setResult({
        kind: 'error',
        title: 'Not a TNL QR code',
        detail: 'Scan the customer\u2019s TNL card or reward QR on their dashboard.',
      })
      scheduleAutoResume(ERROR_HOLD_MS)
      return
    }

    void redeem(decodedText)
  }

  function submitManual(): void {
    const code = manualUserId.trim()
    if (!code) return
    setManualUserId('')
    void redeem(code)
  }

  const paused = submitting || result !== null

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.heading}>Cashier scanner</Text>

      {/* Outcome of the last scan */}
      {result ? (
        <Card
          style={[
            styles.resultCard,
            result.kind === 'success' ? styles.resultSuccess : styles.resultError,
          ]}
        >
          <Text style={[styles.resultTitle, result.kind === 'success' ? styles.textSuccess : styles.textError]}>
            {result.kind === 'success' ? '✅ ' : '⚠️ '}
            {result.title}
          </Text>
          <Text style={styles.resultDetail}>{result.detail}</Text>
          <Text style={styles.resultHint}>
            {submitting ? 'Applying…' : 'Camera resumes automatically…'}
          </Text>
          {!submitting ? (
            <PrimaryButton title="Scan next customer now" onPress={resumeScanning} style={styles.resumeBtn} />
          ) : null}
        </Card>
      ) : null}

      {/* Camera */}
      <Card style={styles.cameraCard}>
        {scanning ? (
          <View style={styles.cameraBox}>
            <QrCamera
              enabled
              paused={paused}
              onScanned={(raw) => {
                if (!submitting && !result) onDecoded(raw)
              }}
            />
          </View>
        ) : (
          <Pressable
            onPress={() => {
              setResult(null)
              setScanning(true)
            }}
            style={({ pressed }) => [styles.startScan, pressed && { opacity: 0.9 }]}
          >
            <Ionicons name="qr-code-outline" size={36} color={colors.bg} />
            <Text style={styles.startScanText}>Start camera</Text>
          </Pressable>
        )}

        {scanning ? (
          <View style={styles.scanControls}>
            {paused ? (
              <PrimaryButton
                title="Resume scanning"
                onPress={resumeScanning}
                disabled={submitting}
                style={styles.controlBtn}
              />
            ) : null}
            <Pressable onPress={stopScanning} style={({ pressed }) => [styles.stopCamera, pressed && { opacity: 0.85 }]}>
              <Text style={styles.stopCameraText}>Stop camera</Text>
            </Pressable>
          </View>
        ) : null}
      </Card>

      {/* Manual fallback for devices without a camera */}
      <Card style={styles.manualCard}>
        <Text style={styles.manualLabel}>Or type a customer id or card kode</Text>
        <TextInput
          value={manualUserId}
          onChangeText={setManualUserId}
          placeholder="customer uuid or TNL-4K7P-2XQ9"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="characters"
          autoCorrect={false}
          style={styles.manualInput}
          returnKeyType="done"
          onSubmitEditing={submitManual}
        />
        <PrimaryButton
          title={submitting ? 'Applying…' : 'Apply discount'}
          onPress={submitManual}
          disabled={!manualUserId.trim()}
          loading={submitting}
          style={styles.applyBtn}
        />
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: spacing.lg },
  resultCard: { marginBottom: spacing.lg, gap: spacing.sm },
  resultSuccess: {
    borderColor: 'rgba(52, 211, 153, 0.4)',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
  },
  resultError: {
    borderColor: 'rgba(239, 68, 68, 0.4)',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  resultTitle: { fontSize: 16, fontWeight: '800' },
  resultDetail: { color: colors.text, fontSize: 14, lineHeight: 20 },
  resultHint: { color: colors.textFaint, fontSize: 12 },
  textSuccess: { color: colors.emeraldText },
  textError: { color: '#fca5a5' },
  resumeBtn: { marginTop: spacing.xs },
  cameraCard: { gap: spacing.md },
  cameraBox: {
    height: 300,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.black,
  },
  startScan: {
    borderRadius: 16,
    backgroundColor: colors.amber,
    paddingVertical: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  startScanText: { color: colors.bg, fontSize: 16, fontWeight: '800' },
  scanControls: { gap: spacing.sm },
  controlBtn: {},
  stopCamera: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    paddingVertical: 12,
    alignItems: 'center',
  },
  stopCameraText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  manualCard: { marginTop: spacing.lg, gap: spacing.md },
  manualLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  manualInput: {
    borderWidth: 1,
    borderColor: colors.borderAlt,
    backgroundColor: colors.bg,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
  },
  applyBtn: {},
})