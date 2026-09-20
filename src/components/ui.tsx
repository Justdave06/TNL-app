import { LinearGradient } from 'expo-linear-gradient'
import * as React from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native'
import { colors, spacing } from '@/lib/theme'

export function Screen({
  children,
  style,
  contentContainerStyle,
  keyboardShouldPersistTaps = 'handled',
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  contentContainerStyle?: StyleProp<ViewStyle>
  keyboardShouldPersistTaps?: 'handled' | 'never' | 'always'
}) {
  return (
    <View style={[styles.screen, style]}>
      <View style={[styles.content, contentContainerStyle]}>{children}</View>
    </View>
  )
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>
}

export function PrimaryButton({
  title,
  onPress,
  disabled,
  loading,
  style,
}: {
  title: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const blocked = disabled || loading
  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      style={({ pressed }) => [
        styles.buttonShadow,
        pressed && !blocked && styles.pressed,
        blocked && styles.disabled,
        style,
      ]}
    >
      <LinearGradient
        colors={[colors.amberLight, colors.red]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.primaryGradient}
      >
        {loading ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <Text style={styles.primaryText}>{title}</Text>
        )}
      </LinearGradient>
    </Pressable>
  )
}

export function OutlineButton({
  title,
  onPress,
  disabled,
  loading,
  style,
}: {
  title: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
  style?: StyleProp<ViewStyle>
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.outline,
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={colors.textMuted} /> : <Text style={styles.outlineText}>{title}</Text>}
    </Pressable>
  )
}

export function LinkButton({
  title,
  onPress,
  style,
}: {
  title: string
  onPress: () => void
  style?: StyleProp<ViewStyle>
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && { opacity: 0.7 }, style]}>
      <Text style={styles.linkText}>{title}</Text>
    </Pressable>
  )
}

export function Field({
  label,
  hint,
  ...inputProps
}: { label?: string; hint?: string } & TextInputProps) {
  const { style: inputStyle, ...restInputProps } = inputProps
  return (
    <View style={[styles.field, { flex: 1 }]}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.amber}
        style={[styles.input, inputStyle]}
        multiline={false}
        numberOfLines={1}
        {...restInputProps}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  )
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null
  return <Text style={styles.error}>{message}</Text>
}

export function Pill({ children, tone = 'amber' }: { children: React.ReactNode; tone?: 'amber' | 'emerald' | 'red' }) {
  return (
    <View style={[styles.pill, tone === 'amber' && styles.pillAmber, tone === 'emerald' && styles.pillEmerald, tone === 'red' && styles.pillRed]}>
      <Text
        style={[
          styles.pillText,
          tone === 'amber' && styles.pillTextAmber,
          tone === 'emerald' && styles.pillTextEmerald,
          tone === 'red' && styles.pillTextRed,
        ]}
      >
        {children}
      </Text>
    </View>
  )
}

export function PointsBar({ progress }: { progress: number }) {
  const width = Math.round(Math.max(0, Math.min(1, progress / 100) * 100))
  return (
    <View style={styles.barTrack}>
      <LinearGradient
        colors={[colors.amberLight, colors.red]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{ width: `${width}%`, height: 12, borderRadius: 999 }}
      />
    </View>
  )
}

/** Thin wrapper used around a QR-scanning CameraView. */
export function SectionTitle({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.sectionTitle, style]}>{children}</Text>
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    padding: spacing.lg,
  },
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(28, 25, 23, 0.6)',
    padding: spacing.xl,
  },
  buttonShadow: {
    shadowColor: colors.amber,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  primaryGradient: {
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    color: colors.bg,
    fontSize: 17,
    fontWeight: '800',
  },
  outline: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  linkText: {
    color: colors.amberText,
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  pressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  disabled: { opacity: 0.5 },
  field: {
    gap: spacing.sm,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '500',
  },
  fieldHint: {
    color: colors.textFaint,
    fontSize: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.borderAlt,
    backgroundColor: colors.bg,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
  },
  error: {
    color: '#fca5a5',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    overflow: 'hidden',
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 3,
  },
  pillAmber: { backgroundColor: 'rgba(245, 158, 11, 0.15)' },
  pillEmerald: { backgroundColor: 'rgba(52, 211, 153, 0.15)' },
  pillRed: { backgroundColor: 'rgba(239, 68, 68, 0.15)' },
  pillText: { fontSize: 13, fontWeight: '700' },
  pillTextAmber: { color: colors.amberText },
  pillTextEmerald: { color: colors.emeraldText },
  pillTextRed: { color: '#fca5a5' },
  barTrack: {
    height: 12,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
})