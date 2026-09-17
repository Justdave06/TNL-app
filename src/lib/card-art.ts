import { Asset } from 'expo-asset'
import * as LegacyFileSystem from 'expo-file-system/legacy'
import QRCode from 'qrcode'
import { Image } from 'react-native'
import { buildPhysicalCardQrPayload, type PhysicalCardEntry } from './loyalty'

/**
 * Official TNL physical-card print pipeline.
 *
 * Mirrors the website's `utils/card-artwork.ts` + `pages/admin/physical-cards.vue`:
 * every card is rendered with the official member-card design (fronts carry the
 * activation QR, backs are the blank official back), then laid out as CR80-sized
 * cards on A4 sheets — fronts first, then backs mirrored horizontally so duplex
 * printing aligns. The result is a single multi-page HTML document that
 * `expo-print` turns into a print-ready PDF.
 */

/** Design-space size; draw at this resolution and scale down when embedding. */
const CARD_ART_W = 1012
const CARD_ART_H = 638

/** CR80 in mm — the standard ID card size. */
const CARD_W_MM = 85.6
const CARD_H_MM = 54
const GAP_MM = 4
const MARGIN_MM = 10
const PER_ROW = 2
const ROWS = 3
const PER_PAGE = PER_ROW * ROWS

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

interface Logo {
  uri: string
  width: number
  height: number
}

let logoPromise: Promise<Logo | null> | null = null

/** Loads the app's logo as a base64 data URI (print HTML cannot read app assets). */
function loadLogo(): Promise<Logo | null> {
  if (!logoPromise) {
    logoPromise = (async () => {
      try {
        const moduleId = require('@/assets/images/logo.png')
        const source = Image.resolveAssetSource(moduleId)
        const asset = Asset.fromModule(moduleId)
        await asset.downloadAsync()
        const base64 = await LegacyFileSystem.readAsStringAsync(asset.localUri ?? asset.uri, {
          encoding: LegacyFileSystem.EncodingType.Base64,
        })
        return {
          uri: `data:image/png;base64,${base64}`,
          width: source.width || 1,
          height: source.height || 1,
        }
      } catch {
        return null
      }
    })()
  }
  return logoPromise
}

/** Renders a QR as an SVG with white modules over transparency (no light plate). */
function renderQrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#ffffff', light: '#00000000' },
  })
}

/** Places a QR svg inside the card, positioned and scaled at design size. */
function placeQr(svg: string, x: number, y: number, size: number): string {
  return svg.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `)
}

/** Soft "noodle line" curves across the card, like the printed design. */
function noodleCurves(id: string): string {
  const wx = CARD_ART_W / 320
  const hx = CARD_ART_H / 202
  const path =
    `M ${167 * wx} ${-20 * hx} ` +
    `C ${135 * wx} ${40 * hx}, ${243 * wx} ${52 * hx}, ${198 * wx} ${108 * hx} ` +
    `C ${165 * wx} ${148 * hx}, ${90 * wx} ${138 * hx}, ${70 * wx} ${222 * hx}`
  const tail = `M ${224 * wx} ${222 * hx} Q ${227 * wx} ${160 * hx}, ${306 * wx} ${172 * hx}`
  return (
    `<g clip-path="url(#tnl-clip-${id})" fill="none" stroke="rgba(255, 255, 255, 0.05)" stroke-linecap="round">` +
    `<path d="${path}" stroke-width="42"/><path d="${tail}" stroke-width="28"/></g>`
  )
}

/** Dark gradient card base: rounded rect, hairline border and noodle curves. */
function cardBase(id: string): string {
  return (
    `<rect x="2" y="2" width="${CARD_ART_W - 4}" height="${CARD_ART_H - 4}" rx="42" fill="url(#tnl-g-${id})" stroke="rgba(255, 255, 255, 0.12)" stroke-width="4"/>` +
    noodleCurves(id)
  )
}

/** Wraps card content in the shared gradient/clip defs for this card. */
function svgWrap(id: string, inner: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_ART_W} ${CARD_ART_H}" width="100%" height="100%">` +
    `<defs>` +
    `<linearGradient id="tnl-g-${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#262524"/><stop offset="0.55" stop-color="#171514"/><stop offset="1" stop-color="#0a0908"/>` +
    `</linearGradient>` +
    `<clipPath id="tnl-clip-${id}"><rect x="0" y="0" width="${CARD_ART_W}" height="${CARD_ART_H}" rx="44"/></clipPath>` +
    `</defs>${inner}</svg>`
  )
}

/** Official card front: logo lockup upper left, activation QR on the right. */
async function cardFrontSvg(id: string, code: string, logo: Logo | null): Promise<string> {
  const qr = await renderQrSvg(buildPhysicalCardQrPayload(code))
  const box = 240
  const bx = CARD_ART_W - box - 72
  const by = (CARD_ART_H - box) / 2

  const cx = 182
  const logoTop = 80
  const logoH = 150
  const lockupBottom = logoTop + logoH
  let mark = ''
  if (logo) {
    const logoW = logo.width * (logoH / logo.height)
    mark = `<image href="${logo.uri}" x="${cx - logoW / 2}" y="${logoTop}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>`
  }

  const inner =
    cardBase(id) +
    mark +
    `<g fill="#fafaf9" text-anchor="middle" font-family='${FONT}'>` +
    `<text x="${cx}" y="${lockupBottom + 40}" font-size="24" font-weight="600" letter-spacing="10">THE</text>` +
    `<text x="${cx}" y="${lockupBottom + 102}" font-size="58" font-weight="600">NOODLE</text>` +
    `<text x="${cx}" y="${lockupBottom + 148}" font-size="38" font-weight="600">LINE</text>` +
    `</g>` +
    placeQr(qr, bx, by, box) +
    `<rect x="${bx - 18}" y="${by - 18}" width="${box + 36}" height="${box + 36}" rx="28" fill="none" stroke="#ffffff" stroke-width="6"/>`

  return svgWrap(id, inner)
}

/** Official card back: centred logo watermark, blank (no name until activation). */
function cardBackSvg(id: string, logo: Logo | null): string {
  let mark = ''
  if (logo) {
    const logoW = 240
    const logoH = logo.height * (logoW / logo.width)
    mark = `<image href="${logo.uri}" x="${(CARD_ART_W - logoW) / 2}" y="${(CARD_ART_H - logoH) / 2 - 10}" width="${logoW}" height="${logoH}" opacity="0.12"/>`
  }
  return svgWrap(id, cardBase(id) + mark)
}

function cardBox(html: string, col: number, row: number): string {
  const left = MARGIN_MM + col * (CARD_W_MM + GAP_MM)
  const top = MARGIN_MM + row * (CARD_H_MM + GAP_MM)
  return `<div class="card" style="left:${left}mm;top:${top}mm">${html}</div>`
}

function pageHtml(children: string, last: boolean): string {
  return `<div class="page${last ? ' page-last' : ''}">${children}</div>`
}

function wrapHtml(body: string, preview: boolean): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=794, initial-scale=1.0" />
    <style>
      @page { size: A4; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: ${preview ? '#e7e5e4' : '#ffffff'}; }
      .page { position: relative; width: 210mm; height: 297mm; page-break-after: always; overflow: hidden; background: #ffffff; }
      .page-last { page-break-after: auto; }
      .card { position: absolute; width: ${CARD_W_MM}mm; height: ${CARD_H_MM}mm; }
      .card > svg { display: block; width: 100%; height: 100%; }
    </style>
  </head>
  <body>${body}</body>
</html>`
}

export interface PhysicalCardSheet {
  /** Full multi-page document: fronts first, then mirrored backs. */
  printHtml: string
  /** First sheet only, for the in-app preview. */
  previewHtml: string
}

/**
 * Builds the printable sheet for a batch: official card fronts (one activation
 * QR each) followed by the blank official backs, mirrored for duplex printing.
 */
export async function buildPhysicalCardSheets(
  cards: PhysicalCardEntry[],
): Promise<PhysicalCardSheet> {
  const logo = await loadLogo()
  const safe = cards.length > 0 ? cards : []

  const frontSvgs: string[] = []
  for (let i = 0; i < safe.length; i += 1) {
    frontSvgs.push(await cardFrontSvg(`f${i}`, safe[i]!.code, logo))
  }
  const backSvg = cardBackSvg('b', logo)

  const pages = Math.max(1, Math.ceil(safe.length / PER_PAGE))

  /* Fronts, page by page. */
  const frontPages: string[] = []
  for (let p = 0; p < pages; p += 1) {
    const count = Math.min(PER_PAGE, safe.length - p * PER_PAGE)
    let body = ''
    for (let j = 0; j < count; j += 1) {
      body += cardBox(frontSvgs[p * PER_PAGE + j]!, j % PER_ROW, Math.floor(j / PER_ROW))
    }
    frontPages.push(body)
  }

  /* Backs, mirrored horizontally so duplex printing aligns with the fronts. */
  const backPages: string[] = []
  for (let p = 0; p < pages; p += 1) {
    const count = Math.min(PER_PAGE, safe.length - p * PER_PAGE)
    let body = ''
    for (let j = 0; j < count; j += 1) {
      body += cardBox(backSvg, PER_ROW - 1 - (j % PER_ROW), Math.floor(j / PER_ROW))
    }
    backPages.push(body)
  }

  const allPages = [...frontPages, ...backPages]
  const printBody = allPages
    .map((body, index) => pageHtml(body, index === allPages.length - 1))
    .join('')

  const previewBody = pageHtml(frontPages[0] ?? '', true)

  return { printHtml: wrapHtml(printBody, false), previewHtml: wrapHtml(previewBody, true) }
}
