import { StockRow, PriceRecord, FinRecord, MasterRecord, StockMeta } from './types'

export function fmtN(v: number | null | undefined, dec = 1): string {
  if (v == null || v === 0) return '—'
  return v.toLocaleString('ja-JP', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}
export function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'
}
export function pctClass(v: number | null | undefined): string {
  if (v == null) return 'flat'
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'
}
export function pctBg(v: number | null | undefined): string {
  if (!v) return ''
  const intensity = Math.min(Math.abs(v) / 0.1, 1)
  if (v > 0) return `rgba(63,185,80,${(intensity * 0.25).toFixed(2)})`
  return `rgba(248,81,73,${(intensity * 0.25).toFixed(2)})`
}
// 変化率の文字色。設計トークンを参照し、ライト/ダーク両方でくっきり読める色に。
// （変動の大小は背景 pctBg の濃さで表現し、文字は常に視認性優先の濃い色にする＝白飛び解消）
export function pctCellColor(v: number | null | undefined): string {
  if (v == null) return 'var(--flat)'
  if (v > 0) return 'var(--up)'
  if (v < 0) return 'var(--down)'
  return 'var(--flat)'
}
export function daysSince(dateStr: string): number {
  if (!dateStr) return 0
  const now = new Date()
  // Date.UTC でローカル日付成分を使うことでTZオフセットの影響を排除
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const parts = dateStr.split('-').map(Number)
  const targetMs = Date.UTC(parts[0], parts[1] - 1, parts[2])
  return Math.max(0, Math.floor((todayMs - targetMs) / 86400000))
}
export function isDataStale(dateStr: string, days = 90): boolean {
  if (!dateStr) return false
  return daysSince(dateStr) >= days
}
export function marketShort(mkt: string): { label: string; cls: string } {
  if (mkt.includes('プライム'))     return { label: 'プライム',     cls: 'prime' }
  if (mkt.includes('スタンダード')) return { label: 'スタンダード', cls: 'standard' }
  if (mkt.includes('グロース'))     return { label: 'グロース',     cls: 'growth' }
  // 米国市場（取引所名から自動判別。呼び出し側の変更不要）
  const u = mkt.toUpperCase()
  if (u.includes('NASDAQ'))                                   return { label: 'NASDAQ', cls: 'nasdaq' }
  if (u.includes('NYSE') && (u.includes('AMERICAN') || u.includes('MKT'))) return { label: 'NYSE American', cls: 'amex' }
  if (u.includes('NYSE'))                                     return { label: 'NYSE',   cls: 'nyse' }
  if (u.includes('AMEX') || u.includes('BATS') || u.includes('CBOE'))      return { label: 'AMEX',   cls: 'amex' }
  return { label: mkt.slice(0, 6) || '—', cls: 'other' }
}

// ── 時価総額の表示（市場でユニットが違う: 日本=億円 / 米国=USD百万）──────
// トグルはグローバルなので、表示専用のカレント市場をモジュール変数で持つ
// （多数の表示コンポーネントに market を配線せずに済ませる軽量策）。
let _displayMarket: 'jp' | 'us' = 'jp'
export function setDisplayMarket(m: 'jp' | 'us') { _displayMarket = m }
// v は JP=億円 / US=USD百万。短縮表記で返す。
export function fmtMcap(v: number | null | undefined): string {
  if (v == null || v === 0 || !isFinite(v)) return '—'
  if (_displayMarket === 'us') {
    if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'T'  // 兆ドル
    if (v >= 1_000)     return '$' + (v / 1_000).toFixed(1) + 'B'      // 十億ドル
    return '$' + Math.round(v).toLocaleString() + 'M'
  }
  // 1000億(=0.1兆)以上は兆表記（桁が多くて数えにくいので 0.5兆 / 25.4兆 のように）
  if (v >= 1000) return (v / 10000).toFixed(1) + '兆'
  return Math.round(v).toLocaleString() + '億'
}

// 全角英数字・記号を半角に（例: Ｓｙｎｓｐｅｃｔｉｖｅ → Synspective）。
// カタカナ・漢字(全角和文)はそのまま。英語名の銘柄が間延びして見えるのを防ぐ表示用正規化。
export function halfWidthAscii(s: string): string {
  return s
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
}
// [旧ロジック: Step1で新エンジンに置換。緊急ロールバック用に残す]
// export function getJudgment(perFChg1m: number | null | undefined): string {
//   if (perFChg1m == null) return ''
//   if (perFChg1m <= -0.05) return '買い'
//   return ''
// }

export function buildStockRow(
  code: string,
  priceDB: Record<string, PriceRecord>,
  finDB: Record<string, FinRecord>,
  masterDB: Record<string, MasterRecord>,
  stockMeta: Record<string, StockMeta>,
  perBandDB?: Record<string, import('./perBand').PerBand | null>
): StockRow {
  const p = priceDB[code] ?? { close: 0 }
  const f = finDB[code]
  const m = masterDB[code]

  const close  = p.close ?? 0
  const eps    = f?.eps   ?? 0
  const feps   = f?.feps  ?? null   // null = 業績予想非開示
  const nyeps  = f?.nyEPS ?? null   // null = 来期予想非開示
  const bps    = f?.bps   ?? 0
  const fdiv   = f?.fdiv  ?? f?.divAnn ?? 0

  const epsCurGr = (eps && feps != null) ? feps / eps - 1 : null
  const perA  = (close && eps)   ? close / eps   : null
  const perF  = (close && feps)  ? close / feps  : null
  const pbr   = (close && bps)   ? close / bps   : null
  const divY  = (close && fdiv > 0) ? fdiv / close : null  // 配当は0超のみ＝マイナス/ゼロ利回りを出さない
  const peg   = (perF != null && epsCurGr !== null && epsCurGr !== 0) ? perF / (epsCurGr * 100) : null
  // 成長加味の予想PER（1年先のEPSに割り戻したイメージ）。成長率が-100%以下なら無効
  const likePer = (close && feps && epsCurGr !== null && (1 + epsCurGr) > 0)
    ? close / (feps * (1 + epsCurGr)) : null

  // 新計算式: (現在PER) / (過去PER) - 1 = (close * pastFeps) / (pastClose * feps) - 1
  // pastFeps が null の場合は null を返す（≠ 非開示。IPO直後等でデータなし）
  function perFChgAt(pastClose: number | undefined, pastFeps: number | null): number | null {
    if (!pastClose || !close || !feps || !pastFeps) return null
    return (close * pastFeps) / (pastClose * feps) - 1
  }
  const prev1m = (p as { prev1m?: number }).prev1m
  // perFChgXmPrev = 過去時点の実PER（過去株価 / 過去FEPS）
  const perFChg1mPrev  = (prev1m   && f?.feps1m) ? prev1m    / f.feps1m : null

  const meta = stockMeta[code]
  const genres = meta?.genres ?? []

  return {
    code,
    name:       halfWidthAscii(m?.name ?? ''),
    market:     m?.market ?? '',
    genres,
    close,
    chg1d:      p.chg1d ?? null,
    chg1w:      p.chg1w ?? null,
    chg1m:      (close && prev1m) ? close / prev1m - 1 : null,
    chg3m:      p.chg3m ?? null,
    chg1y:      p.chg1y ?? null,
    mcap:       p.mcap  ?? 0,
    perA, perF,
    perFChg1m:  perFChgAt(prev1m, f?.feps1m ?? null),
    perFChg1mPrev,
    pbr,
    roe:        f?.roe    ?? null,
    divY,
    epsCurGr,
    peg,
    likePer,
    opMgn:      f?.opMgn  ?? null,
    nySalesGr:  f?.nySalesGr ?? null,
    judgment:   '',  // [旧: getJudgment(perFAt(prev1m)) → page.tsx の判定エンジンに移行]
    perBand:    perBandDB?.[code] ?? null,
    sicLabel:   m?.sicLabel,
  }
}
