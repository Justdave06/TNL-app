import { useEffect } from 'react'
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import QRCode from 'react-native-qrcode-svg'
import { colors, spacing } from '@/lib/theme'

/**
 * Double-sided 3D flip card. Tap anywhere on the card to flip between the
 * front (brand + reward QR) and the back (member name).
 *
 * Both faces are rendered on top of each other; each face's opacity is derived
 * from the shared rotation value so the back becomes visible exactly at the
 * 90° midpoint, and backfaceVisibility hides each face when it faces away.
 * Flip state is controlled by the parent so a button can drive the same flip.
 */
export default function FlipCard({
  qrPayload,
  memberName,
  flipped,
  onToggleFlipped,
}: {
  qrPayload: string
  memberName: string
  flipped: boolean
  onToggleFlipped: () => void
}) {
  const spin = useSharedValue(flipped ? 1 : 0)

  // Keep the animation in sync with the controlled flip state.
  useEffect(() => {
    spin.value = withTiming(flipped ? 1 : 0, { duration: 500 })
  }, [flipped, spin])

  const frontAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 1000 },
      { rotateY: `${spin.value * 180}deg` },
    ],
    opacity: interpolate(spin.value, [0, 0.5, 1], [1, 0, 0]),
  }))

  const backAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 1000 },
      { rotateY: `${180 + spin.value * 180}deg` },
    ],
    opacity: interpolate(spin.value, [0, 0.5, 1], [0, 0, 1]),
  }))

  return (
    <Pressable onPress={onToggleFlipped} accessibilityRole="button" accessibilityLabel="Flip card">
      <View style={styles.flipArea}>
        {/* Front face: brand lockup + reward QR. */}
        <Animated.View style={[styles.face, frontAnimatedStyle]}>
          <LinearGradient colors={['#1c1917', '#0c0a09', '#000000']} style={styles.cardArt}>
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
        </Animated.View>

        {/* Back face: mirrored watermark + member name. */}
        <Animated.View style={[styles.face, backAnimatedStyle]} pointerEvents="none">
          <LinearGradient colors={['#1c1917', '#0c0a09', '#000000']} style={styles.cardArt}>
            <Image
              source={require('@/assets/images/logo.png')}
              style={styles.watermark}
              contentFit="contain"
            />
            <View style={styles.backNameRow}>
              <Text style={styles.memberName} numberOfLines={1}>
                {memberName}
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // The wrapper defines the card's footprint (both faces are absolutely
  // positioned inside it, so it cannot derive height from its children).
  flipArea: { position: 'relative', width: '100%', aspectRatio: 1.586 },
  face: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backfaceVisibility: 'hidden',
  },
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
})
