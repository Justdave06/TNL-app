import { Ionicons } from '@expo/vector-icons'
import { Link } from 'expo-router'
import * as React from 'react'
import { Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as api from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import {
  CAP_APPRECIATION_MESSAGE,
  MAX_POINT_BALANCE,
  REWARD_MIN_POINTS,
  discountPercentForPoints,
  normalizeVoucherCode,
  pointsUntilReward,
} from '@/lib/loyalty'
import { colors, spacing } from '@/lib/theme'
import { useToast } from '@/lib/toast'
import { Card, ErrorText, Field, Pill, PointsBar, PrimaryButton } from '@/components/ui'

export default function DashboardScreen() {
  const { user, refresh } = useAuth()
  const { push } = useToast()

  const [code, setCode] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)

  const normalized = normalizeVoucherCode(code)
  const valid = normalized != null
  const percent = user ? discountPercentForPoints(user.points) : 0
  const canRedeem = user && user.points >= REWARD_MIN_POINTS

  function handleRefresh() {
    return refresh().finally(() => setRefreshing(false))
  }

  async function redeem() {
    if (!normalized || submitting) return
    Keyboard.dismiss()
    setSubmitting(true)
    setError(null)
    try {
      const result = await api.redeemVoucher(normalized)
      setCode('')
      if (result.pending) {
        push('Kode submitted - points appear once you are back online', 'info', 6000)
      } else {
        push(`You earned ${result.pointsAdded} pt!`, 'success')
      }
      const fresh = await refresh()
      if (fresh && fresh.capReached) push('Balance cap reached! You must redeem before collecting more.', 'info', 8000)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!user) return null

  const expiryHint =
    user.expiries.length > 0
      ? `Oldest points expire ${new Date(user.expiries[0]).toLocaleDateString()}`
      : null

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl tintColor={colors.amber} refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      <Text style={styles.greeting}>Hi, {user.name.split(' ')[0]}! 👋</Text>

      {/* Points hero */}
      <Card style={styles.hero}>
        <View style={styles.heroTop}>
          <View>
            <Text style={styles.heroLabel}>Total points</Text>
            <View style={styles.pointsRow}>
              <Text style={styles.heroPoints}>{user.points}</Text>
              <Text style={styles.heroUnit}>pts</Text>
            </View>
          </View>
          {user.capReached ? <Pill tone="red">Cap reached</Pill> : <Pill>{percent}% discount</Pill>}
        </View>

        <PointsBar progress={(user.points / MAX_POINT_BALANCE) * 100} />

        <View style={styles.heroFootnote}>
          {user.capReached ? (
            <Text style={styles.footnote}>You can redeem now - full {percent}% on your next bowl!</Text>
          ) : (
            <Text style={styles.footnote}>
              {user.points >= REWARD_MIN_POINTS
                ? `Every point = 2% discount. Tap My Card to show your code at checkout.`
                : `${pointsUntilReward(user.points)} more pt${pointsUntilReward(user.points) === 1 ? '' : 's'} until your first discount unlocks.`}
            </Text>
          )}
        </View>
        {expiryHint ? <Text style={styles.expiryHint}>{expiryHint}</Text> : null}
      </Card>

      {user.capReached ? (
        <Text style={styles.capNote}>{CAP_APPRECIATION_MESSAGE}</Text>
      ) : null}

      {/* Ballot / card kode entry */}
      <View style={styles.block}>
        <Text style={styles.sectionTitle}>Add Card Kode</Text>
        <Text style={styles.sectionSub}>
          Enter the code from your receipt or loyalty card to earn points.
        </Text>
        <View style={styles.redeemRow}>
          <Field
            value={code}
            onChangeText={(text) => setCode(text.toUpperCase())}
            placeholder="RMY-XXXX-XXXX"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.redeemInput}
            returnKeyType="done"
            onSubmitEditing={redeem}
          />
          {canRedeem ? (
            <PrimaryButton
              title="Redeem"
              onPress={redeem}
              disabled={!valid}
              loading={submitting}
              style={styles.redeemBtn}
            />
          ) : (
            <PrimaryButton
              title="Collect"
              onPress={redeem}
              disabled={!valid}
              loading={submitting}
              style={styles.redeemBtn}
            />
          )}
        </View>
        {error ? <ErrorText message={error} /> : null}
      </View>

      {/* Card shortcut */}
      <Card style={styles.shortcut}>
        <View style={styles.shortcutRow}>
          <View style={styles.shortcutIcon}>
            <Ionicons name="qr-code" size={26} color={colors.amberLight} />
          </View>
          <View style={styles.shortcutBody}>
            <Text style={styles.shortcutTitle}>Redeem your discount</Text>
            <Text style={styles.shortcutSub}>Show your card at the counter for a {percent}% off your bowl.</Text>
          </View>
          <Link href="/(member)/card" asChild>
            <Pressable style={styles.linkPill}>
              <Text style={styles.linkPillText}>Open</Text>
            </Pressable>
          </Link>
        </View>
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  greeting: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: spacing.lg },
  hero: {
    borderColor: 'rgba(245, 158, 11, 0.35)',
    gap: spacing.lg,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  heroLabel: { color: colors.textMuted, fontSize: 14, fontWeight: '500' },
  pointsRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  heroPoints: { color: colors.amberText, fontSize: 44, fontWeight: '900', letterSpacing: -1 },
  heroUnit: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
  heroFootnote: { marginTop: -4 },
  footnote: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  expiryHint: { color: colors.textFaint, fontSize: 12 },
  capNote: {
    marginTop: spacing.md,
    color: colors.amberText,
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 13,
    lineHeight: 19,
  },
  block: { marginTop: spacing.xxl, gap: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  sectionSub: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  redeemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  redeemInput: { flex: 1, height: 52 },
  redeemBtn: { minWidth: 100 },
  shortcut: { marginTop: spacing.xxl },
  shortcutRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  shortcutIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutBody: { flex: 1, gap: 2 },
  shortcutTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  shortcutSub: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  linkPill: {
    backgroundColor: colors.amber,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  linkPillText: { color: colors.bg, fontSize: 14, fontWeight: '800' },
})