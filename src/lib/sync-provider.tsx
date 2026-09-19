import { Ionicons } from '@expo/vector-icons'
import * as React from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as db from './db'
import * as sync from './sync'
import { colors, spacing } from './theme'

/**
 * Sync status context + a slim overlay banner. The banner surfaces what
 * offline-first usually hides: a queued write still waiting to reach the
 * server, a rejected push, or a session that needs a fresh login.
 */

interface SyncContextValue {
  status: sync.SyncStatus
  notices: db.NoticeRow[]
  syncNow: () => Promise<void>
  clearNotices: () => Promise<void>
}

const SyncContext = React.createContext<SyncContextValue | null>(null)

export function useSync(): SyncContextValue {
  const context = React.useContext(SyncContext)
  if (!context) throw new Error('useSync must be used within a SyncProvider')
  return context
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<sync.SyncStatus>(() => sync.getSyncStatus())
  const [notices, setNotices] = React.useState<db.NoticeRow[]>([])

  React.useEffect(() => sync.subscribeSync(setStatus), [])
  React.useEffect(() => {
    void sync.refreshPendingCount()
    void db
      .listNotices()
      .then(setNotices)
      .catch(() => undefined)
  }, [])

  const syncNow = React.useCallback(() => sync.syncNow(), [])
  const clearNotices = React.useCallback(async () => {
    await db.clearNotices()
    setNotices([])
  }, [])

  const value = React.useMemo(
    () => ({ status, notices, syncNow, clearNotices }),
    [status, notices, syncNow, clearNotices],
  )

  return (
    <SyncContext.Provider value={value}>
      {children}
      <SyncOverlay />
    </SyncContext.Provider>
  )
}

/* -------------------------------------------------------------------------- */
/* Overlay banner                                                             */
/* -------------------------------------------------------------------------- */

const OFFLINE_MESSAGES: Partial<Record<sync.SyncState, string>> = {
  syncing: 'Syncing…',
  offline: 'You are offline',
  'needs-login': 'Sign in again to sync',
  error: 'Sync needs attention',
}

function SyncOverlay() {
  const { status, notices, syncNow, clearNotices } = useSync()
  const insets = useSafeAreaInsets()
  const [expanded, setExpanded] = React.useState(false)

  const active = status.state !== 'idle' || status.pendingCount > 0

  if (!active) return null

  const pending = status.pendingCount > 0
  const pill = status.state === 'needs-login' ? colors.amber : status.state === 'error' ? colors.red : colors.amber
  const label =
    status.state === 'error'
      ? status.lastError ?? OFFLINE_MESSAGES.error
      : (status.pendingCount > 0 ? `${OFFLINE_MESSAGES[status.state] ?? 'Online'} · ${status.pendingCount} queued` : OFFLINE_MESSAGES[status.state] ?? '')

  const handleSync = async () => {
    await syncNow()
    setExpanded(false)
  }

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrapper, { top: insets.top, zIndex: 1000 }]}
    >
      <View style={[styles.bar, { borderColor: pill }]}>
        {status.state === 'syncing' ? (
          <ActivityIndicator size="small" color={colors.amberLight} />
        ) : (
          <Ionicons name="cloud-offline-outline" size={16} color={pill} />
        )}
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <Pressable onPress={handleSync} style={styles.iconButton} hitSlop={8}>
          <Ionicons name="refresh" size={16} color={colors.text} />
        </Pressable>
        {notices.length > 0 || pending ? (
          <Pressable
            onPress={() => setExpanded((open) => !open)}
            style={styles.iconButton}
            hitSlop={8}
          >
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.text} />
          </Pressable>
        ) : null}
      </View>

      {expanded ? (
        <View style={styles.panel}>
          {notices.length === 0 ? (
            <Text style={styles.panelEmpty}>No issues to show.</Text>
          ) : (
            <ScrollView style={styles.noticeList} bounces={false}>
              {notices.map((notice) => (
                <View key={notice.id} style={styles.notice}>
                  <Text style={styles.noticeTitle}>{notice.title}</Text>
                  <Text style={styles.noticeMessage}>{notice.message}</Text>
                </View>
              ))}
            </ScrollView>
          )}
          {notices.length > 0 ? (
            <Pressable onPress={() => void clearNotices()} style={styles.clearButton} hitSlop={6}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  label: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  iconButton: {
    paddingHorizontal: 2,
  },
  panel: {
    marginTop: spacing.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    borderRadius: 12,
    padding: spacing.md,
    maxHeight: 220,
  },
  noticeList: {
    flexGrow: 0,
  },
  notice: {
    gap: 2,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderAlt,
  },
  noticeTitle: {
    color: colors.amberText,
    fontSize: 13,
    fontWeight: '700',
  },
  noticeMessage: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  panelEmpty: {
    color: colors.textMuted,
    fontSize: 13,
  },
  clearButton: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
  clearText: {
    color: colors.amber,
    fontSize: 13,
    fontWeight: '700',
  },
})