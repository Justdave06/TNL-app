import { Ionicons } from '@expo/vector-icons'
import { Link } from 'expo-router'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as api from '@/lib/api'
import { describeError } from '@/lib/errors'
import { colors, spacing } from '@/lib/theme'
import { Card } from '@/components/ui'

interface Shortcut {
  href: '/(admin)/scan' | '/(admin)/vouchers' | '/(admin)/physical-cards'
  icon: keyof typeof Ionicons.glyphMap
  title: string
}

const SHORTCUTS: Shortcut[] = [
  { href: '/(admin)/scan', icon: 'qr-code-outline', title: 'Cashier scanner' },
  { href: '/(admin)/vouchers', icon: 'pricetags-outline', title: 'Points cards' },
  { href: '/(admin)/physical-cards', icon: 'card-outline', title: 'Physical cards' },
]

export default function AdminOverviewScreen() {
  const [count, setCount] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  // Keep all setStates after the first await so load() never mutates state synchronously.
  const load = React.useCallback(async () => {
    try {
      setCount(await api.fetchCustomerCount())
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [])

  // Mount-time fetch through a nested async fn (react.dev "You Might Not
  // Need an Effect") so the effect body itself never calls setState.
  React.useEffect(() => {
    async function run() {
      await load()
    }
    void run()
  }, [load])

  function handleRefresh() {
    return load().finally(() => setRefreshing(false))
  }


  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl tintColor={colors.amber} refreshing={refreshing} onRefresh={handleRefresh} />
      }
    >
      <Text style={styles.heading}>Dashboard</Text>

      <Card style={styles.statCard}>
        <Text style={styles.statLabel}>Registered users</Text>
        <Text style={styles.statValue}>{count ?? '—'}</Text>
        {error ? <Text style={styles.statHint}>{error}</Text> : null}
      </Card>

      <Text style={styles.sectionTitle}>Manage</Text>
      <View style={styles.shortcutList}>
        {SHORTCUTS.map((shortcut) => (
          <Link key={shortcut.href} href={shortcut.href} asChild>
            <Pressable style={({ pressed }) => [pressed && { opacity: 0.9 }]}>
              <Card style={styles.shortcutCard}>
                <View style={styles.shortcutIcon}>
                  <Ionicons name={shortcut.icon} size={24} color={colors.amberLight} />
                </View>
                <View style={styles.shortcutBody}>
                  <Text style={styles.shortcutTitle}>{shortcut.title}</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
              </Card>
            </Pressable>
          </Link>
        ))}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: spacing.lg },
  statCard: {
    borderColor: 'rgba(245, 158, 11, 0.35)',
    gap: spacing.xs,
  },
  statLabel: { color: colors.textMuted, fontSize: 14, fontWeight: '500' },
  statValue: { color: colors.amberText, fontSize: 44, fontWeight: '900', letterSpacing: -1 },
  statHint: { color: colors.textFaint, fontSize: 12, lineHeight: 17 },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginTop: spacing.xxl,
    marginBottom: spacing.sm,
  },
  shortcutList: { gap: spacing.md },
  shortcutCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, padding: spacing.lg },
  shortcutIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutBody: { flex: 1, gap: 2 },
  shortcutTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
})
