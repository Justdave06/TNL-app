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
import { WebView } from 'react-native-webview'
import * as api from '@/lib/api'
import { buildPhysicalCardSheets, type PhysicalCardSheet } from '@/lib/card-art'
import { describeError } from '@/lib/errors'
import { MAX_PHYSICAL_BATCH_SIZE, type PhysicalCardBatch } from '@/lib/loyalty'
import { sharePdf } from '@/lib/sheet'
import { colors, spacing } from '@/lib/theme'
import { useToast } from '@/lib/toast'
import { Card, ErrorText, Field, Pill, PrimaryButton } from '@/components/ui'

interface SheetState extends PhysicalCardSheet {
  batchId: string
  count: number
}

export default function PhysicalCardsScreen() {
  const { push } = useToast()

  const [batches, setBatches] = React.useState<PhysicalCardBatch[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [quantity, setQuantity] = React.useState('10')
  const [generating, setGenerating] = React.useState(false)

  const [sheet, setSheet] = React.useState<SheetState | null>(null)
  const [loadingPreviewId, setLoadingPreviewId] = React.useState<string | null>(null)
  const [sharing, setSharing] = React.useState(false)

  const loadBatches = React.useCallback(async () => {
    try {
      setError(null)
      const data = await api.fetchPhysicalCardBatches()
      setBatches(data.batches)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadBatches()
  }, [loadBatches])

  async function generate() {
    if (generating) return
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_PHYSICAL_BATCH_SIZE) {
      setError(`Quantity must be between 1 and ${MAX_PHYSICAL_BATCH_SIZE}`)
      return
    }
    Keyboard.dismiss()
    setGenerating(true)
    setError(null)
    try {
      const result = await api.createPhysicalCardBatch(qty)
      const built = await buildPhysicalCardSheets(result.cards)
      setSheet({ ...built, batchId: result.batch.id, count: result.cards.length })
      push(`${result.cards.length} physical cards created — PDF preview ready`, 'success')
      await loadBatches()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setGenerating(false)
    }
  }

  async function openPreview(batchId: string) {
    if (loadingPreviewId) return
    setLoadingPreviewId(batchId)
    setError(null)
    try {
      const data = await api.fetchPhysicalCardCards(batchId)
      const built = await buildPhysicalCardSheets(data.cards)
      setSheet({ ...built, batchId, count: data.cards.length })
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoadingPreviewId(null)
    }
  }

  async function shareSheet() {
    if (!sheet || sharing) return
    setSharing(true)
    setError(null)
    try {
      await sharePdf(
        sheet.printHtml,
        `TNL physical cards (${sheet.count})`,
        `tnl-cards-${sheet.batchId.slice(0, 8)}.pdf`,
      )
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSharing(false)
    }
  }

  const batchLabel = sheet ? sheet.batchId.slice(0, 8) : ''

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>Physical cards</Text>

      <Card style={styles.generator}>
        <Text style={styles.cardTitle}>Print a new batch</Text>
        <Field
          label="Number of cards to generate"
          value={quantity}
          onChangeText={(text) => setQuantity(text.replace(/[^0-9]/g, '').slice(0, 3))}
          keyboardType="numeric"
          placeholder="10"
          hint={`1 – ${MAX_PHYSICAL_BATCH_SIZE} cards`}
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

      {sheet ? (
        <Card style={styles.previewCard}>
          <View style={styles.previewHead}>
            <Text style={styles.cardTitle}>PDF preview</Text>
            <Pressable onPress={() => setSheet(null)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.previewMeta}>
            {sheet.count} cards · batch {batchLabel}
          </Text>

          <View style={styles.viewer}>
            <WebView
              originWhitelist={['*']}
              source={{ html: sheet.previewHtml }}
              scalesPageToFit
              scrollEnabled={false}
              javaScriptEnabled={false}
              style={styles.webview}
            />
          </View>

          <PrimaryButton
            title={sharing ? 'Preparing…' : 'Share / print PDF'}
            onPress={shareSheet}
            loading={sharing}
            style={styles.shareBtn}
          />
        </Card>
      ) : null}

      <Text style={styles.sectionTitle}>Print runs</Text>

      {loading ? (
        <ActivityIndicator color={colors.amber} style={styles.loading} />
      ) : batches.length === 0 ? (
        <Text style={styles.empty}>No cards printed yet. Generate a batch above.</Text>
      ) : (
        batches.map((batch) => (
          <Card key={batch.id} style={styles.batchCard}>
            <View style={styles.batchInfo}>
              <Text style={styles.batchTitle}>{batch.total} cards</Text>
              <Text style={styles.batchMeta}>
                <Text style={styles.batchActivated}>{batch.activated}</Text> / {batch.total} activated
                {'  ·  '}
                {new Date(batch.createdAt).toLocaleDateString()}
              </Text>
              <Pill>Non-expiry</Pill>
            </View>
            <Pressable
              onPress={() => openPreview(batch.id)}
              disabled={loadingPreviewId === batch.id}
              style={({ pressed }) => [styles.viewBtn, pressed && { opacity: 0.85 }]}
            >
              {loadingPreviewId === batch.id ? (
                <ActivityIndicator color={colors.textMuted} size="small" />
              ) : (
                <>
                  <Ionicons name="eye-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.viewBtnText}>Preview PDF</Text>
                </>
              )}
            </Pressable>
          </Card>
        ))
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: spacing.lg },
  generator: { gap: spacing.md },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  generateBtn: { marginTop: spacing.xs },
  previewCard: { marginTop: spacing.lg, gap: spacing.sm },
  previewHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeText: { color: colors.amberText, fontSize: 14, fontWeight: '600' },
  previewMeta: { color: colors.textMuted, fontSize: 13 },
  viewer: {
    marginTop: spacing.sm,
    width: '100%',
    aspectRatio: 210 / 297,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#e7e5e4',
    borderWidth: 1,
    borderColor: colors.borderAlt,
  },
  webview: { flex: 1, backgroundColor: 'transparent' },
  shareBtn: { marginTop: spacing.sm },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginTop: spacing.xxl,
    marginBottom: spacing.sm,
  },
  loading: { marginTop: spacing.lg },
  empty: { color: colors.textFaint, fontSize: 13, marginTop: spacing.sm },
  batchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  batchInfo: { flex: 1, gap: 4, alignItems: 'flex-start' },
  batchTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  batchMeta: { color: colors.textMuted, fontSize: 13 },
  batchActivated: { color: colors.emeraldText, fontWeight: '800' },
  viewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.borderAlt,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    minWidth: 118,
    justifyContent: 'center',
  },
  viewBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
})
