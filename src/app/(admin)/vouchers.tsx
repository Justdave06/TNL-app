import { Ionicons } from '@expo/vector-icons'
import * as React from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import * as api from '@/lib/api'
import { describeError } from '@/lib/errors'
import {
  formatVoucherCode,
  MAX_VOUCHER_BATCH_SIZE,
  VOUCHER_POINT_TIERS,
  type VoucherBatch,
  type VoucherCardEntry,
  type VoucherTier,
} from '@/lib/loyalty'
import { sharePdf, buildPointsSheetHtml } from '@/lib/sheet'
import { colors, spacing } from '@/lib/theme'
import { useToast } from '@/lib/toast'
import { Card, ErrorText, Field, Pill, PrimaryButton } from '@/components/ui'

export default function VouchersScreen() {
  const { push } = useToast()

  const [batches, setBatches] = React.useState<VoucherBatch[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [tier, setTier] = React.useState<VoucherTier>(1)
  const [quantity, setQuantity] = React.useState('10')
  const [generating, setGenerating] = React.useState(false)

  const [expanded, setExpanded] = React.useState<VoucherTier | null>(null)
  const [cards, setCards] = React.useState<Partial<Record<VoucherTier, VoucherCardEntry[]>>>({})
  const [loadingCards, setLoadingCards] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [removing, setRemoving] = React.useState(false)
  const [sharing, setSharing] = React.useState(false)

  const loadBatches = React.useCallback(async () => {
    try {
      setError(null)
      const data = await api.fetchVoucherBatches()
      setBatches(data.batches)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCards = React.useCallback(async (points: VoucherTier) => {
    setLoadingCards(true)
    try {
      const data = await api.fetchVoucherCardsByPoints(points)
      setCards((prev) => ({ ...prev, [points]: data.cards }))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoadingCards(false)
    }
  }, [])

  React.useEffect(() => {
    void loadBatches()
  }, [loadBatches])

  async function generate() {
    if (generating) return
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_VOUCHER_BATCH_SIZE) {
      setError(`Quantity must be between 1 and ${MAX_VOUCHER_BATCH_SIZE}`)
      return
    }
    Keyboard.dismiss()
    setGenerating(true)
    setError(null)
    try {
      const result = await api.createVoucherBatch(tier, qty)
      push(`${result.cards.length} cards created and ready to print`, 'success')
      setSelected(new Set())
      await loadBatches()
      setExpanded(tier)
      await loadCards(tier)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setGenerating(false)
    }
  }

  async function toggleTier(points: VoucherTier) {
    if (expanded === points) {
      setExpanded(null)
      setSelected(new Set())
      return
    }
    setExpanded(points)
    setSelected(new Set())
    if (!cards[points]) await loadCards(points)
  }

  function toggleSelected(code: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  async function removeClaimed() {
    if (selected.size === 0 || removing) return
    setRemoving(true)
    setError(null)
    try {
      const result = await api.deleteClaimedVouchers([...selected])
      push(`${result.deleted} card${result.deleted === 1 ? '' : 's'} removed`, 'success')
      setSelected(new Set())
      if (expanded) await loadCards(expanded)
      await loadBatches()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setRemoving(false)
    }
  }

  async function shareSheet(points: VoucherTier) {
    const list = cards[points] ?? []
    if (list.length === 0) return
    setSharing(true)
    setError(null)
    try {
      const html = buildPointsSheetHtml(`${points} point card${points === 1 ? '' : 's'}`, list)
      await sharePdf(html, `TNL ${points} point cards`)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSharing(false)
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>Points cards</Text>

      <Card style={styles.generator}>
        <Text style={styles.cardTitle}>Print a new batch</Text>

        <View style={styles.tierRow}>
          {VOUCHER_POINT_TIERS.map((points) => {
            const active = tier === points
            return (
              <Pressable
                key={points}
                onPress={() => setTier(points)}
                style={[styles.tierButton, active && styles.tierButtonActive]}
              >
                <Text style={[styles.tierText, active && styles.tierTextActive]}>
                  {points} point{points === 1 ? '' : 's'}
                </Text>
              </Pressable>
            )
          })}
        </View>

        <Field
          label="Quantity"
          value={quantity}
          onChangeText={(text) => setQuantity(text.replace(/[^0-9]/g, '').slice(0, 3))}
          keyboardType="numeric"
          placeholder="10"
          hint={`1 – ${MAX_VOUCHER_BATCH_SIZE} cards`}
          returnKeyType="done"
          onSubmitEditing={generate}
        />

        <PrimaryButton
          title="Generate cards"
          onPress={generate}
          loading={generating}
          style={styles.generateBtn}
        />
        {error ? <ErrorText message={error} /> : null}
      </Card>

      <Text style={styles.sectionTitle}>Your card pools</Text>

      {loading ? (
        <ActivityIndicator color={colors.amber} style={styles.loading} />
      ) : batches.length === 0 ? (
        <Text style={styles.empty}>No cards printed yet. Generate a batch above.</Text>
      ) : (
        batches.map((batch) => {
          const open = expanded === batch.points
          const list = cards[batch.points] ?? []
          const claimedCodes = list.filter((card) => card.redeemedAt).map((card) => card.code)
          const selectable = new Set(claimedCodes)
          const selectedClaimed = [...selected].filter((code) => selectable.has(code))
          return (
            <Card key={batch.points} style={styles.batchCard}>
              <View style={styles.batchHead}>
                <View style={styles.batchInfo}>
                  <Text style={styles.batchTitle}>
                    {batch.points} point{batch.points === 1 ? '' : 's'}
                  </Text>
                  <Text style={styles.batchMeta}>
                    <Text style={styles.batchClaimed}>{batch.redeemed}</Text> / {batch.total} claimed
                    {'  ·  '}
                    {new Date(batch.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Pressable
                  onPress={() => toggleTier(batch.points)}
                  style={({ pressed }) => [styles.viewBtn, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.viewBtnText}>{open ? 'Hide' : 'View cards'}</Text>
                </Pressable>
              </View>

              {open ? (
                <View style={styles.drawer}>
                  {loadingCards && list.length === 0 ? (
                    <ActivityIndicator color={colors.amber} />
                  ) : (
                    <>
                      <View style={styles.drawerActions}>
                        <Pressable
                          onPress={() => shareSheet(batch.points)}
                          disabled={sharing || list.length === 0}
                          style={({ pressed }) => [
                            styles.sheetBtn,
                            (sharing || list.length === 0) && styles.disabled,
                            pressed && { opacity: 0.85 },
                          ]}
                        >
                          <Ionicons name="print-outline" size={16} color={colors.amberText} />
                          <Text style={styles.sheetBtnText}>Print sheet</Text>
                        </Pressable>
                        <Pressable
                          onPress={removeClaimed}
                          disabled={removing || selectedClaimed.length === 0}
                          style={({ pressed }) => [
                            styles.removeBtn,
                            (removing || selectedClaimed.length === 0) && styles.disabled,
                            pressed && { opacity: 0.85 },
                          ]}
                        >
                          <Text style={styles.removeBtnText}>
                            Remove claimed ({selectedClaimed.length})
                          </Text>
                        </Pressable>
                      </View>

                      {list.map((card) => {
                        const claimed = card.redeemedAt != null
                        const checked = selected.has(card.code)
                        return (
                          <Pressable
                            key={card.code}
                            onPress={claimed ? () => toggleSelected(card.code) : undefined}
                            style={[styles.codeRow, claimed && styles.codeRowClaimed]}
                          >
                            <Text style={styles.codeText}>{formatVoucherCode(card.code)}</Text>
                            {claimed ? (
                              <View style={styles.codeRight}>
                                <Pill tone="red">claimed</Pill>
                                <Ionicons
                                  name={checked ? 'checkbox' : 'square-outline'}
                                  size={20}
                                  color={checked ? colors.amberText : colors.textFaint}
                                />
                              </View>
                            ) : (
                              <Pill>{card.points} pt</Pill>
                            )}
                          </Pressable>
                        )
                      })}
                    </>
                  )}
                </View>
              ) : null}
            </Card>
          )
        })
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: spacing.lg },
  generator: { gap: spacing.md },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  tierRow: { flexDirection: 'row', gap: spacing.sm },
  tierButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tierButtonActive: { borderColor: colors.amber, backgroundColor: 'rgba(245, 158, 11, 0.12)' },
  tierText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  tierTextActive: { color: colors.amberText, fontWeight: '800' },
  generateBtn: { marginTop: spacing.xs },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginTop: spacing.xxl,
    marginBottom: spacing.sm,
  },
  loading: { marginTop: spacing.lg },
  empty: { color: colors.textFaint, fontSize: 13, marginTop: spacing.sm },
  batchCard: { gap: spacing.md, marginBottom: spacing.md },
  batchHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  batchInfo: { flex: 1, gap: 2 },
  batchTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  batchMeta: { color: colors.textMuted, fontSize: 13 },
  batchClaimed: { color: colors.emeraldText, fontWeight: '800' },
  viewBtn: {
    borderWidth: 1,
    borderColor: colors.borderAlt,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  viewBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  drawer: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  drawerActions: { flexDirection: 'row', gap: spacing.sm },
  sheetBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
    borderRadius: 10,
    paddingVertical: 9,
  },
  sheetBtnText: { color: colors.amberText, fontSize: 13, fontWeight: '700' },
  removeBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderRadius: 10,
    paddingVertical: 9,
  },
  removeBtnText: { color: '#fca5a5', fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  codeRowClaimed: { opacity: 0.6 },
  codeText: { color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: 1 },
  codeRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
})
