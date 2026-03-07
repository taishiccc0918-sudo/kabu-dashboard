import { PriceRecord, FinRecord, MasterRecord } from './types'

async function jqFetch(path: string, apiKey: string) {
  const res = await fetch(`/api/jquants?path=${encodeURIComponent(path)}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

function normalizeCode(raw: string): string {
  if (raw.length === 5 && raw.endsWith('0')) return raw.slice(0, 4)
  return raw
}

function n(v: unknown): number {
  const f = parseFloat(String(v ?? ''))
  return isNaN(f) ? 0 : f
}

function bizDateMinus(dateStr8: string, days: number): string {
  const y = +dateStr8.slice(0, 4)
  const m = +dateStr8.slice(4, 6) - 1
  const d = +dateStr8.slice(6, 8)
  const date = new Date(y, m, d)
  let cnt = 0
  while (cnt < days) {
    date.setDate(date.getDate() - 1)
    if (date.getDay() !== 0 && date.getDay() !== 6) cnt++
  }
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

export async function findLatestBizDate(apiKey: string): Promise<{ dateStr: string; dateDisp: string }> {
  const d = new Date()
  for (let i = 0; i < 10; i++) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '')
      try {
        const data = await jqFetch(`/equities/bars/daily?code=13010&date=${dateStr}`, apiKey)
        if (data.data?.length > 0) {
          return { dateStr, dateDisp: d.toISOString().slice(0, 10) }
        }
      } catch { /* try previous day */ }
    }
    d.setDate(d.getDate() - 1)
  }
  const fallback = new Date()
  fallback.setDate(fallback.getDate() - 1)
  return {
    dateStr: fallback.toISOString().slice(0, 10).replace(/-/g, ''),
    dateDisp: fallback.toISOString().slice(0, 10),
  }
}

export async function fetchMaster(apiKey: string): Promise<Record<string, MasterRecord>> {
  const data = await jqFetch('/equities/master', apiKey)
  const db: Record<string, MasterRecord> = {}
  for (const d of data.data ?? []) {
    const code = normalizeCode(d.Code)
    db[code] = { name: d.CoName ?? '', market: d.MktNm ?? d.MarketProductCategory ?? '' }
  }
  return db
}

export async function fetchPrices(
  apiKey: string,
  dateStr: string
): Promise<Record<string, PriceRecord>> {
  const db: Record<string, PriceRecord> = {}

  // 当日
  const today = await jqFetch(`/equities/bars/daily?date=${dateStr}`, apiKey)
  for (const d of today.data ?? []) {
    const code = normalizeCode(d.Code)
    db[code] = {
      close: d.AdjC || d.C || 0,
      open:  d.AdjO || d.O || 0,
      high:  d.AdjH || d.H || 0,
      low:   d.AdjL || d.L || 0,
      vol:   d.Vo   || 0,
    }
  }

  // 過去データ取得: 指定日にデータがない場合は前後3営業日を探す（祝日・休場対応）
  async function fetchPastDate(baseDays: number): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    for (let offset = 0; offset <= 4; offset++) {
      for (const sign of [0, -1, 1, -2, 2]) {
        const actualDays = baseDays + sign + offset
        if (actualDays < 0) continue
        try {
          const pd = bizDateMinus(dateStr, actualDays)
          const past = await jqFetch(`/equities/bars/daily?date=${pd}`, apiKey)
          const records = past.data ?? []
          if (records.length > 10) {  // データが存在する日
            for (const d of records) {
              const code = normalizeCode(d.Code)
              const p = d.AdjC || d.C || 0
              if (p && !map.has(code)) map.set(code, p)
            }
            return map  // 見つかったら即返す
          }
        } catch { /* try next */ }
      }
    }
    return map
  }

  // 4時点のデータを並行取得
  const [prev1dMap, prev1wMap, prev1mMap, prev3mMap, prev1yMap] = await Promise.all([
    fetchPastDate(1),
    fetchPastDate(5),
    fetchPastDate(21),
    fetchPastDate(65),
    fetchPastDate(252),
  ])

  const periodMaps: { map: Map<string,number>; key: 'prev1d'|'prev1w'|'prev1m'|'prev3m'|'prev1y'; chgKey?: 'chg1d'|'chg1w'|'chg3m'|'chg1y' }[] = [
    { map: prev1dMap, key: 'prev1d', chgKey: 'chg1d' },
    { map: prev1wMap, key: 'prev1w', chgKey: 'chg1w' },
    { map: prev1mMap, key: 'prev1m' },
    { map: prev3mMap, key: 'prev3m', chgKey: 'chg3m' },
    { map: prev1yMap, key: 'prev1y', chgKey: 'chg1y' },
  ]
  for (const { map, key, chgKey } of periodMaps) {
    for (const [code, p] of Array.from(map.entries())) {
      if (!db[code]) db[code] = { close: 0 }
      db[code][key] = p
      if (chgKey && db[code].close && p) db[code][chgKey] = db[code].close / p - 1
    }
  }

  return db
}

export async function fetchFinancials(
  apiKey: string,
  watchlist: string[]
): Promise<{ finDB: Record<string, FinRecord>; shOutDB: Record<string, number> }> {
  const finDB: Record<string, FinRecord> = {}
  const shOutDB: Record<string, number> = {}

  // 最大2回リトライ
  // 全stmtから最善の値を拾う汎用関数
  function bestVal(stmts: Record<string,string>[], ...keys: string[]): number {
    for (const key of keys) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const v = n(stmts[i][key])
        if (v !== 0) return v
      }
    }
    return 0
  }

  async function fetchOne(code: string): Promise<boolean> {
    try {
      await new Promise(r => setTimeout(r, 120))
      const data = await jqFetch(`/fins/summary?code=${code}`, apiKey)
      const stmts: Record<string, string>[] = data.data ?? []
      if (stmts.length === 0) return false

      // FY / 非FY を両方探す
      let latestFY: Record<string, string> | null = null
      let latestNonFY: Record<string, string> | null = null
      for (let j = stmts.length - 1; j >= 0; j--) {
        const s = stmts[j]
        if (s.CurPerType === 'FY' && !latestFY) latestFY = s
        if (s.CurPerType !== 'FY' && s.CurPerType && !latestNonFY) latestNonFY = s
        if (latestFY && latestNonFY) break
      }
      const fy  = latestFY  ?? stmts[stmts.length - 1]
      const nfy = latestNonFY ?? fy
      const all = stmts  // 全データから拾うフォールバック用

      const shOut = bestVal(all, 'ShOutFY', 'ShOut')
      if (shOut > 0) shOutDB[code] = shOut

      const equity = bestVal(all, 'Eq')
      const assets = bestVal(all, 'TA')
      const sales  = bestVal(all, 'Sales')
      const op     = bestVal(all, 'OP')
      const np     = bestVal(all, 'NP')
      const eps    = bestVal(all, 'EPS')
      const bps    = bestVal(all, 'BPS')

      // 予想EPS: 直近非FY優先、なければFY、なければ全stmtから
      const feps   = n(nfy.FEPS) || n(fy.FEPS) || bestVal(all, 'FEPS')
      const nyEPS  = n(fy.NxFEPS) || n(nfy.NxFEPS) || bestVal(all, 'NxFEPS')
      const fsales = n(nfy.FSales) || n(fy.FSales) || bestVal(all, 'FSales')
      const nySales= n(fy.NxFSales) || n(nfy.NxFSales) || bestVal(all, 'NxFSales')
      const fdiv   = n(nfy.FDivAnn) || n(nfy.DivAnn) || n(fy.FDivAnn) || n(fy.DivAnn) || bestVal(all, 'FDivAnn','DivAnn')
      const fop    = n(nfy.FOP) || n(fy.FOP) || bestVal(all, 'FOP')
      const nyOP   = n(fy.NxFOP) || n(nfy.NxFOP) || bestVal(all, 'NxFOP')

      finDB[code] = {
        sales, op, odp: bestVal(all, 'OdP'), np, eps, feps, nyEPS, bps,
        equity, assets, divAnn: bestVal(all, 'DivAnn'),
        fdiv, shOut,
        discDate: fy.DiscDate ?? '',
        perType: fy.CurPerType ?? '',
        fsales, fop, nySales, nyOP,
        roe:      equity ? np / equity : 0,
        eqRat:    assets ? equity / assets : 0,
        opMgn:    sales  ? op / sales : 0,
        salesGr:  (sales && fsales) ? fsales / sales - 1 : 0,
        nySalesGr:(fsales && nySales) ? nySales / fsales - 1 : 0,
      }
      return true
    } catch { return false }
  }

  // 全銘柄取得（失敗したものはリトライ）
  const failed: string[] = []
  for (const code of watchlist) {
    const ok = await fetchOne(code)
    if (!ok) failed.push(code)
  }
  // 失敗分を段階的にリトライ（最大3回）
  let remaining = failed
  for (const waitMs of [600, 1200, 2000]) {
    if (remaining.length === 0) break
    await new Promise(r => setTimeout(r, waitMs))
    const stillFailed: string[] = []
    for (const code of remaining) {
      const ok = await fetchOne(code)
      if (!ok) stillFailed.push(code)
    }
    remaining = stillFailed
  }

  return { finDB, shOutDB }
}

export async function fetchAnnouncements(
  apiKey: string,
  finDB: Record<string, FinRecord>
): Promise<Record<string, FinRecord>> {
  try {
    const data = await jqFetch('/fins/announcement', apiKey)
    for (const d of data.data ?? []) {
      const code = normalizeCode(d.Code ?? '')
      if (finDB[code]) {
        (finDB[code] as FinRecord & { nextEarnings?: string }).nextEarnings =
          d.DisclosedDate ?? d.DiscDate ?? ''
      }
    }
  } catch { /* skip */ }
  return finDB
}

export interface ChartPoint { date: string; close: number; volume: number }

export async function fetchChartData(
  apiKey: string,
  code: string,
  fromDate: string // YYYYMMDD
): Promise<ChartPoint[]> {
  // 正しいパラメータ名: dateFrom / dateTo
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const data = await jqFetch(
    `/equities/bars/daily?code=${code}&dateFrom=${fromDate}&dateTo=${today}`,
    apiKey
  )
  return (data.data ?? [])
    .map((d: Record<string, string>) => ({
      date: d.Date ?? '',
      close: parseFloat(d.AdjC ?? d.C ?? '0') || 0,
      volume: parseFloat(d.Vo ?? '0') || 0,
    }))
    .filter((d: ChartPoint) => d.close > 0)
    .sort((a: ChartPoint, b: ChartPoint) => a.date.localeCompare(b.date))
}
