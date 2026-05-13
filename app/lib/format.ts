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
// 変化率の色強度: ±5%超=鮮やか、±5%未満=控えめ
export function pctCellColor(v: number | null | undefined): string {
  if (v == null) return '#6b7280'
  const abs = Math.abs(v)
  if (v > 0) return abs >= 0.05 ? '#10b981' : 'rgba(52,211,153,0.65)'
  if (v < 0) return abs >= 0.05 ? '#f43f5e' : 'rgba(248,113,113,0.65)'
  return '#6b7280'
}
export function marketShort(mkt: string): { label: string; cls: string } {
  if (mkt.includes('プライム'))     return { label: 'Prime',    cls: 'prime' }
  if (mkt.includes('スタンダード')) return { label: 'Standard', cls: 'standard' }
  if (mkt.includes('グロース'))     return { label: 'Growth',   cls: 'growth' }
  return { label: mkt.slice(0, 6) || '—', cls: 'other' }
}
export function getJudgment(perFChg1m: number | null | undefined): string {
  if (perFChg1m == null) return ''
  if (perFChg1m <= -0.05) return '買い'
  return ''
}

export function buildStockRow(
  code: string,
  priceDB: Record<string, PriceRecord>,
  finDB: Record<string, FinRecord>,
  masterDB: Record<string, MasterRecord>,
  stockMeta: Record<string, StockMeta>
): StockRow {
  const p = priceDB[code] ?? { close: 0 }
  const f = finDB[code]
  const m = masterDB[code]

  const close  = p.close ?? 0
  const eps    = f?.eps   ?? 0
  const feps   = f?.feps  ?? 0
  const nyeps  = f?.nyEPS ?? 0
  const bps    = f?.bps   ?? 0
  const fdiv   = f?.fdiv  ?? f?.divAnn ?? 0

  const epsGr = (eps && feps)   ? feps  / eps   - 1 : null
  const perA  = (close && eps)   ? close / eps   : null
  const perF  = (close && feps)  ? close / feps  : null
  const perN  = (close && nyeps) ? close / nyeps : null
  const pbr   = (close && bps)   ? close / bps   : null
  const divY  = (close && fdiv)  ? fdiv  / close : null
  const peg   = (perF && epsGr && epsGr > 0) ? perF / (epsGr * 100) : null

  function perFAt(pastClose: number | undefined): number | null {
    if (!pastClose || !close || !feps) return null
    return close / pastClose - 1
  }
  const prev1m = (p as { prev1m?: number }).prev1m
  const perFChg1mPrev = (prev1m && feps) ? prev1m / feps : null

  const meta = stockMeta[code]
  const genres = meta?.genres ?? []

  return {
    code,
    name:       m?.name   ?? '',
    market:     m?.market ?? '',
    genres,
    close,
    chg1d:      p.chg1d ?? null,
    chg1w:      p.chg1w ?? null,
    chg3m:      p.chg3m ?? null,
    chg1y:      p.chg1y ?? null,
    mcap:       p.mcap  ?? 0,
    perA, perF, perN,
    perFChg1w:  perFAt(p.prev1w),
    perFChg1m:  perFAt(prev1m),
    perFChg1mPrev,
    perFChg3m:  perFAt(p.prev3m),
    perFChg1y:  perFAt(p.prev1y),
    pbr,
    roe:        f?.roe    ?? null,
    divY,
    epsGr,
    peg,
    opMgn:      f?.opMgn  ?? null,
    nySalesGr:  f?.nySalesGr ?? null,
    judgment:   getJudgment(perFAt(prev1m)),
  }
}
