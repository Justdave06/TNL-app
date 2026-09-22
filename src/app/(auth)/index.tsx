import { LinearGradient } from 'expo-linear-gradient'
import { Image } from 'expo-image'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useAuth } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { colors, spacing } from '@/lib/theme'
import { useState, useRef } from 'react'

export default function AuthScreen() {
  const { signIn, signUp } = useAuth()
  const [signupActive, setSignupActive] = useState(false)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameRef = useRef<TextInput>(null)
  const phoneRef = useRef<TextInput>(null)
  const pinRef = useRef<TextInput>(null)

  const phoneClean = phone.replace(/\s/g, '').replace(/^0/, '')
  const valid = signupActive
    ? name.trim().length > 0 && phoneClean.length === 10 && /^\d{10}$/.test(phoneClean) && pin.length >= 4
    : phoneClean.length === 10 && /^\d{10}$/.test(phoneClean) && pin.length >= 4

  function reset() {
    setSubmitting(false)
    setError(null)
  }

  function switchMode(nextSignupActive: boolean) {
    reset()
    setSignupActive(nextSignupActive)
    setTimeout(() => (nextSignupActive ? nameRef.current : phoneRef.current)?.focus(), 60)
  }

  async function submit() {
    if (!valid || submitting) return
    reset()
    setSubmitting(true)
    const canonicalPhone = `0${phoneClean}`
    try {
      if (signupActive) await signUp(name.trim(), canonicalPhone, pin)
      else await signIn(canonicalPhone, pin)
    } catch (err) {
      setError(describeError(err))
      setSubmitting(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.wrap}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Image source={require('@/assets/images/logo.png')} style={styles.logo} contentFit="contain" />

        <Text style={styles.heading}>The Noodle Line</Text>

        <View style={styles.card}>
          <Text style={styles.title}>Welcome back!</Text>
          <Text style={styles.subtitle}>Scan, earn, and redeem rewards with every bowl of ramyun.</Text>

          <View style={styles.form}>
            {signupActive && (
              <View style={styles.field}>
                <Text style={styles.label}>Name</Text>
                <TextInput
                  ref={nameRef}
                  value={name}
                  onChangeText={setName}
                  placeholder="e.g. Adrian"
                  placeholderTextColor={colors.textFaint}
                  autoComplete="name"
                  textContentType="name"
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => phoneRef.current?.focus()}
                  selectionColor={colors.amber}
                  style={styles.input}
                />
              </View>
            )}

            <View style={styles.field}>
              <Text style={styles.label}>Phone number</Text>
              <TextInput
                ref={phoneRef}
                value={phone}
                onChangeText={(text) => {
                  const cleaned = text.replace(/[^0-9\s]/g, '')
                  if (cleaned.replace(/\s/g, '').length > 11) return
                  setPhone(cleaned)
                }}
                placeholder="09XX XXX XXXX"
                placeholderTextColor={colors.textFaint}
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                autoComplete="tel"
                maxLength={13}
                returnKeyType="next"
                onSubmitEditing={() => pinRef.current?.focus()}
                selectionColor={colors.amber}
                style={styles.input}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>PIN</Text>
              <TextInput
                ref={pinRef}
                value={pin}
                onChangeText={(text) => setPin(text.replace(/[^0-9]/g, ''))}
                placeholder="Enter PIN"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                keyboardType="numeric"
                textContentType="oneTimeCode"
                maxLength={6}
                returnKeyType="done"
                onSubmitEditing={submit}
                selectionColor={colors.amber}
                style={styles.input}
              />
            </View>

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>

          <Pressable
            disabled={!valid || submitting}
            onPress={submit}
            style={({ pressed }) => [
              styles.btnWrap,
              (!valid || submitting) && styles.btnDisabled,
              pressed && valid && { opacity: 0.92, transform: [{ scale: 0.99 }] },
            ]}
          >
            <LinearGradient
              colors={[colors.amberLight, colors.red]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.btn}
            >
              <Text style={styles.btnText}>{signupActive ? 'Create account' : 'Sign in'}</Text>
            </LinearGradient>
          </Pressable>

          <Pressable onPress={() => switchMode(!signupActive)}>
            <Text style={styles.toggleText}>
              {signupActive ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.footer}>© {new Date().getFullYear()} The Noodle Line. All rights reserved.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  wrap: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  logo: { width: 48, height: 48, alignSelf: 'center', marginBottom: spacing.lg },
  heading: { color: colors.text, fontSize: 26, fontWeight: '800', textAlign: 'center', marginBottom: spacing.xl },
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(28, 25, 23, 0.6)',
    padding: spacing.xl,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: colors.textMuted, fontSize: 14, marginTop: 4, textAlign: 'center' },
  form: { marginTop: spacing.xl, gap: spacing.lg },
  field: { gap: spacing.sm },
  label: { color: colors.textMuted, fontSize: 14, fontWeight: '500' },
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
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  errorText: { color: '#fca5a5', fontSize: 14, lineHeight: 20 },
  btnWrap: { marginTop: spacing.xl },
  btn: { borderRadius: 14, paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: colors.bg, fontSize: 17, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },
  toggleText: {
    color: colors.amberText,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: spacing.xl,
    textDecorationLine: 'underline',
  },
  footer: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: spacing.xl },
})