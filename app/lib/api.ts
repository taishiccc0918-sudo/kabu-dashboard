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

  // 過去4時点
  const periods = [
    { days: 1,   key: 'prev1d' as const, chgKey: 'chg1d' as const },
    { days: 5,   key: 'prev1w' as const, chgKey: 'chg1w' as const },
    { days: 65,  key: 'prev3m' as const, chgKey: 'chg3m' as const },
    { days: 252, key: 'prev1y' as const, chgKey: 'chg1y' as const },
  ]
  for (const { days, key, chgKey } of periods) {
    try {
      const pd = bizDateMinus(dateStr, days)
      const past = await jqFetch(`/equities/bars/daily?date=${pd}`, apiKey)
      for (const d of past.data ?? []) {
        const code = normalizeCode(d.Code)
        if (!db[code]) db[code] = { close: 0 }
        const p = d.AdjC || d.C || 0
        db[code][key] = p
        if (db[code].close && p) db[code][chgKey] = db[code].close / p - 1
      }
    } catch { /* skip on error */ }
  }

  return db
}

export async function fetchFinancials(
  apiKey: string,
  watchlist: string[]
): Promise<{ finDB: Record<string, FinRecord>; shOutDB: Record<string, number> }> {
  const finDB: Record<string, FinRecord> = {}
  const shOutDB: Record<string, number> = {}

  for (const code of watchlist) {
    try {
      const data = await jqFetch(`/fins/summary?code=${code}`, apiKey)
      const stmts: Record<string, string>[] = data.data ?? []
      if (stmts.length === 0) continue

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

      const shOut = n(fy.ShOutFY)
      if (shOut > 0) shOutDB[code] = shOut

      const equity = n(fy.Eq)
      const assets = n(fy.TA)
      const sales  = n(fy.Sales)
      const op     = n(fy.OP)
      const np     = n(fy.NP)
      const fsales = n(nfy.FSales) || n(fy.FSales)
      const nySales= n(fy.NxFSales) || n(nfy.NxFSales)

      finDB[code] = {
        sales, op, odp: n(fy.OdP), np,
        eps:    n(fy.EPS),
        feps:   n(nfy.FEPS)    || n(fy.FEPS),
        nyEPS:  n(fy.NxFEPS)   || n(nfy.NxFEPS),
        bps:    n(fy.BPS),
        equity, assets,
        divAnn: n(fy.DivAnn),
        fdiv:   n(nfy.FDivAnn) || n(nfy.DivAnn) || n(fy.FDivAnn) || n(fy.DivAnn),
        shOut,
        discDate: fy.DiscDate ?? '',
        perType:  fy.CurPerType ?? '',
        fsales, fop: n(nfy.FOP) || n(fy.FOP),
        nySales, nyOP: n(fy.NxFOP) || n(nfy.NxFOP),
        roe:      equity ? np / equity : 0,
        eqRat:    assets ? equity / assets : 0,
        opMgn:    sales  ? op / sales : 0,
        salesGr:  (sales && fsales)   ? fsales  / sales   - 1 : 0,
        nySalesGr:(fsales && nySales) ? nySales / fsales  - 1 : 0,
      }
    } catch { /* skip */ }
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
