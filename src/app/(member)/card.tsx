import { Ionicons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { Image } from 'expo-image'
import * as React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import QrCamera from '@/components/qr-scanner'
import { PrimaryButton, OutlineButton, Pill, Card } from '@/components/ui'
import * as api from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { saveViewAsImage } from '@/lib/capture'
import { describeError } from '@/lib/errors'
import {
  discountPercentForPoints,
  formatPhysicalCardCode,
  parsePhysicalCardQrPayload,
} from '@/lib/loyalty'
import { colors, spacing } from '@/lib/theme'
import { useToast } from '@/lib/toast'

/** Ignore repeat decodes of the same code for this long. */
const DUPLICATE_WINDOW_MS = 5000

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'member'
  )
}

export default function CardScreen() {
  const { user, refresh } = useAuth()
  const { push } = useToast()

  // The QR carries the current live-award snapshot so the cashier can redeem it
  // with no network; it is rebuilt whenever the balance or awards change.
  const [qrPayload, setQrPayload] = React.useState('')

  React.useEffect(() => {
    let cancelled = false
    void api
      .buildRewardQr()
      .then((payload) => {
        if (!cancelled) setQrPayload(payload)
      })
      .catch(() => {
        if (!cancelled) setQrPayload('')
      })
    return () => {
      cancelled = true
    }
  }, [user?.id, user?.points])

  /* Poll for balance changes from a cashier redeeming this customer's QR. */
  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [refresh])

  /* --------------------------- Activation state --------------------------- */
  const [scanning, setScanning] = React.useState(false)
  const [activating, setActivating] = React.useState(false)
  const [scanError, setScanError] = React.useState<string | null>(null)
  const [justActivated, setJustActivated] = React.useState<string | null>(null)
  const [showManualEntry, setShowManualEntry] = React.useState(false)
  const [manualKode, setManualKode] = React.useState('')

  /* ------------------------------ Card art -------------------------------- */
  const [flipped, setFlipped] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const cardRef = React.useRef<View>(null)

  const activated = user?.hasPhysicalCard ?? false
  const showActivating = !activated && !justActivated
  const percent = user ? discountPercentForPoints(user.points) : 0

  const lastDecodedRef = React.useRef('')
  const lastDecodedAtRef = React.useRef(0)

  function onDecoded(decodedText: string): void {
    const now = Date.now()
    if (decodedText === lastDecodedRef.current && now - lastDecodedAtRef.current < DUPLICATE_WINDOW_MS) return
    lastDecodedRef.current = decodedText
    lastDecodedAtRef.current = now

    const code = parsePhysicalCardQrPayload(decodedText)
    if (!code) {
      setScanError('That is not a TNL card QR — scan the code printed on the front of your physical card.')
      return
    }
    void activate(code)
  }

  async function activate(code: string): Promise<void> {
    if (activating) return
    setActivating(true)
    setScanError(null)

    try {
      await api.activatePhysicalCard(code)
      setJustActivated(code)
      setScanning(false)
      push('Your TNL card is now linked to your account. 🎉', 'success', 6000)
      await refresh()
    } catch (error) {
      setScanError(describeError(error))
    } finally {
      setActivating(false)
    }
  }

  async function activateManually(): Promise<void> {
    if (activating || !manualKode) return
    await activate(manualKode)
    if (justActivated) setManualKode('')
  }

  async function saveCard(): Promise<void> {
    if (saving) return
    setSaving(true)
    try {
      await saveViewAsImage(cardRef, `tnl-card-${user ? slugify(user.name) : 'member'}`)
      push('Saved to your photo library.', 'success')
    } catch (error) {
      push(describeError(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!user) return null

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.heading}>My TNL Card</Text>
      <Text style={styles.subheading}>Your digital loyalty card.</Text>

      {showActivating ? (
        <Card style={styles.activateCard}>
          <Text style={styles.sectionTitle}>Activate your card</Text>
          <Text style={styles.sectionSub}>
            Bought a TNL card? Scan the QR code printed on the front — the card is then linked to
            this account and your digital card unlocks.
          </Text>

          {scanning ? (
            <View style={styles.cameraBox}>
              <QrCamera
                enabled
                paused={activating}
                onScanned={(raw) => {
                  if (!activating) onDecoded(raw)
                }}
              />
            </View>
          ) : (
            <Pressable
              onPress={() => {
                setScanError(null)
                setScanning(true)
              }}
              style={({ pressed }) => [styles.startScan, pressed && { opacity: 0.9 }]}
            >
              <Ionicons name="camera" size={30} color={colors.bg} />
              <Text style={styles.startScanText}>Scan card QR</Text>
            </Pressable>
          )}

          {scanning ? (
            <Pressable
              onPress={() => setScanning(false)}
              style={({ pressed }) => [styles.stopCamera, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.stopCameraText}>Stop camera</Text>
            </Pressable>
          ) : null}

          {scanError ? <Text style={styles.errorText}>{scanError}</Text> : null}

          <Pressable onPress={() => setShowManualEntry((v) => !v)}>
            <Text style={styles.manualLink}>
              {showManualEntry ? 'Hide manual entry' : 'No camera? Enter the kode instead'}
            </Text>
          </Pressable>

          {showManualEntry ? (
            <View style={styles.manualRow}>
              <TextInput
                value={manualKode}
                onChangeText={(text) =>
                  setManualKode(
                    text.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12),
                  )
                }
                placeholder="TNL-4K7P-2XQ9"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.manualInput}
                returnKeyType="done"
                onSubmitEditing={activateManually}
              />
              <PrimaryButton
                title={activating ? 'Linking…' : 'Activate card'}
                onPress={activateManually}
                disabled={!manualKode}
                loading={activating}
                style={styles.manualBtn}
              />
            </View>
          ) : null}
        </Card>
      ) : justActivated ? (
        <Card style={styles.successCard}>
          <Text style={styles.successTitle}>Card activated 🎉</Text>
          <Text style={styles.successSub}>
            Kode {formatPhysicalCardCode(justActivated)} is now linked to your account.
          </Text>
          <PrimaryButton title="Show my card" onPress={() => setJustActivated(null)} style={styles.successBtn} />
        </Card>
      ) : (
        <>
          <View ref={cardRef} collapsable={false}>
            {flipped ? (
              <LinearGradient
                colors={['#1c1917', '#0c0a09', '#000000']}
                style={styles.cardArt}
              >
                <Image
                  source={require('@/assets/images/logo.png')}
                  style={styles.watermark}
                  contentFit="contain"
                />
                <View style={styles.backNameRow}>
                  <Text style={styles.memberName} numberOfLines={1}>
                    {user.name}
                  </Text>
                </View>
              </LinearGradient>
            ) : (
              <LinearGradient
                colors={['#1c1917', '#0c0a09', '#000000']}
                style={styles.cardArt}
              >
                <View style={styles.noodleA} />
                <View style={styles.noodleB} />
                <View style={styles.brandLockup}>
                  <Image source={require('@/assets/images/logo.png')} style={styles.logo} contentFit="contain" />
                  <Text style={styles.brandThe}>The</Text>
                  <Text style={styles.brandLine}>Noodle</Text>
                  <Text style={styles.brandLine}>Line</Text>
                </View>
                {qrPayload ? (
                  <View style={styles.qrFrame}>
                    <QRCode value={qrPayload} size={88} color="#ffffff" backgroundColor="transparent" />
                  </View>
                ) : null}
              </LinearGradient>
            )}
          </View>

          <View style={styles.cardActions}>
            <OutlineButton title={flipped ? 'Show front' : 'Show back'} onPress={() => setFlipped((f) => !f)} />
            <PrimaryButton
              title={saving ? 'Saving…' : 'Save my card'}
              onPress={saveCard}
              loading={saving}
              style={styles.saveBtn}
            />
            <Pressable disabled style={styles.orderBtn}>
              <Text style={styles.orderBtnText}>Order a card</Text>
              <Pill>Coming soon</Pill>
            </Pressable>
          </View>

          {user.points >= 5 ? (
            <View style={styles.pointsPillRow}>
              <Pill tone="emerald">Redeem {percent}% at checkout</Pill>
            </View>
          ) : null}

          <Text style={styles.footerNote}>
            Print it at any outlet — the cashier scans the QR to redeem your rewards.
          </Text>
        </>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subheading: { color: colors.textMuted, fontSize: 14, marginTop: 2, marginBottom: spacing.lg },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  sectionSub: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  activateCard: { gap: spacing.md },
  cameraBox: {
    height: 240,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.black,
    marginTop: spacing.md,
  },
  startScan: {
    borderRadius: 14,
    backgroundColor: colors.amber,
    marginTop: spacing.md,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  startScanText: { color: colors.bg, fontSize: 16, fontWeight: '800' },
  stopCamera: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  stopCameraText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  errorText: {
    color: '#fca5a5',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 13,
    overflow: 'hidden',
  },
  manualLink: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
    textDecorationLine: 'underline',
    textAlign: 'center',
    paddingVertical: spacing.sm,
  },
  manualRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  manualInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    backgroundColor: colors.bg,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  manualBtn: { minWidth: 140 },
  successCard: {
    borderColor: 'rgba(52, 211, 153, 0.4)',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    gap: spacing.md,
  },
  successTitle: { color: colors.emeraldText, fontSize: 18, fontWeight: '800' },
  successSub: { color: colors.text, fontSize: 14, lineHeight: 20 },
  successBtn: { marginTop: spacing.sm },
  cardArt: {
    aspectRatio: 1.586,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
    padding: spacing.lg,
  },
  noodleA: {
    position: 'absolute',
    width: 220,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.05)',
    top: 16,
    left: 40,
    transform: [{ rotate: '-14deg' }],
  },
  noodleB: {
    position: 'absolute',
    width: 180,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.05)',
    bottom: 40,
    right: -30,
    transform: [{ rotate: '12deg' }],
  },
  brandLockup: { flexDirection: 'column', alignItems: 'center', alignSelf: 'flex-start' },
  logo: { width: 44, height: 44 },
  brandThe: {
    color: colors.white,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 4,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  brandLine: {
    color: colors.white,
    fontSize: 20,
    fontWeight: '700',
    textTransform: 'uppercase',
    lineHeight: 21,
  },
  qrFrame: {
    position: 'absolute',
    right: spacing.lg,
    top: '50%',
    transform: [{ translateY: -52 }],
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: 14,
    padding: 8,
    backgroundColor: 'transparent',
  },
  watermark: {
    position: 'absolute',
    left: '25%',
    top: '20%',
    width: 120,
    height: 120,
    opacity: 0.1,
  },
  backNameRow: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
  },
  memberName: {
    color: '#fafaf9',
    fontSize: 20,
    fontWeight: '800',
  },
  cardActions: { marginTop: spacing.xl, gap: spacing.md },
  saveBtn: { shadowOpacity: 0 },
  orderBtn: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    paddingVertical: 13,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    opacity: 0.7,
  },
  orderBtnText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
  pointsPillRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  footerNote: {
    color: colors.textFaint,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
})