import { Image } from 'expo-image'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth } from '@/lib/auth'
import { colors, spacing } from '@/lib/theme'
import { Pill } from './ui'

export default function Header() {
  const { user, signOut } = useAuth()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + spacing.md }]}>
      <Image source={require('@/assets/images/logo.png')} style={styles.logo} contentFit="contain" />
      <Text style={styles.title} numberOfLines={1}>
        The Noodle Line
      </Text>

      <View style={styles.right}>
        {user && user.role === 'customer' && (
          <Pill>{user.points} pts</Pill>
        )}
        <Pressable
          onPress={() => signOut()}
          style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(28, 25, 23, 0.6)',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  logo: {
    width: 28,
    height: 28,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  right: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  signOut: {
    borderWidth: 1,
    borderColor: colors.borderAlt,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  signOutText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  pressed: { opacity: 0.75 },
})