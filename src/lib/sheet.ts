import * as Print from 'expo-print'
import * as Sharing from 'expo-sharing'
import { File, Paths, EncodingType } from 'expo-file-system'
import { formatVoucherCode, type VoucherCardEntry } from './loyalty'

/**
 * Admin print helpers. Both card types are exported as print-ready PDFs through
 * `expo-print` and handed to the OS share sheet, which is where printing and
 * "save to files" live on a phone. Physical cards build their HTML in
 * `card-art.ts` so the printed artwork matches the official member card.
 */

export async function sharePdf(
  html: string,
  dialogTitle: string,
  filename = 'tnl-print.pdf',
): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html })

  /*
   * `expo-print` writes into its own cache sub-directory, which the Expo Go
   * runtime's permission service marks unreadable — both legacy `copyAsync`
   * (source unreadable) and `shareAsync` ("Not allowed to read file under
   * given URL") fail on it. Read the bytes through React Native's fetch
   * (OkHttp, not subject to expo module path permissions) and rewrite them
   * with the new expo-file-system API into the cache root, which shareAsync
   * does accept. If anything goes wrong, fall back to the original URI.
   */
  let shareUri = uri
  try {
    const response = await fetch(uri)
    if (!response.ok) throw new Error(`fetch status ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
    const target = new File(Paths.cache, filename)
    if (target.exists) target.delete()
    target.create({ intermediates: true })
    target.write(btoa(binary), { encoding: EncodingType.Base64 })
    shareUri = target.uri
  } catch {
    shareUri = uri
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(shareUri, { UTI: '.pdf', mimeType: 'application/pdf', dialogTitle })
  } else {
    await Print.printAsync({ html })
  }
}

/** A4 sheet of points-card codes, laid out for cutting into individual cards. */
export function buildPointsSheetHtml(title: string, cards: VoucherCardEntry[]): string {
  const items = cards
    .map(
      (card) => `
        <div class="card">
          <div class="brand">THE NOODLE LINE</div>
          <div class="kode">${formatVoucherCode(card.code)}</div>
          <div class="points">${card.points} POINT${card.points === 1 ? '' : 'S'}</div>
        </div>`,
    )
    .join('')

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        @page { margin: 12mm; }
        * { box-sizing: border-box; }
        body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 0; color: #0c0a09; }
        h1 { font-size: 16px; margin: 0 0 12px; }
        .grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .card {
          width: 46%;
          border: 1.5px dashed #a8a29e;
          border-radius: 10px;
          padding: 14px;
          text-align: center;
        }
        .brand { font-size: 9px; letter-spacing: 2px; color: #78716c; }
        .kode { font-size: 20px; font-weight: 800; letter-spacing: 1px; margin: 6px 0; }
        .points { font-size: 12px; font-weight: 700; color: #b45309; }
      </style>
    </head>
    <body>
      <h1>${title}</h1>
      <div class="grid">${items}</div>
    </body>
  </html>`
}
