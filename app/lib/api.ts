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
    for (let offset = 0; offset <= 6; offset++) {
      for (const sign of [0, -1, 1, -2, 2, -3, 3]) {
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


export interface FinResult { fin: FinRecord; shOut: number }


// ─────────────────────────────────────────────────────────────────────
// fetchAllFinancials: /fins/summary を一括取得（レート制限回避）
// J-Quants V2は code なしで全上場銘柄の最新財務サマリーを1回で返す
// ─────────────────────────────────────────────────────────────────────
export async function fetchFinancialOne(apiKey: string, code: string): Promise<FinResult | null> {
  function bestVal(stmts: Record<string,string>[], ...keys: string[]): number {
    for (const key of keys) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const v = n(stmts[i][key])
        if (v !== 0) return v
      }
    }
    return 0
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 600 * Math.pow(2, attempt)))
      const data = await jqFetch(`/fins/summary?code=${code}`, apiKey)
      const stmts: Record<string, string>[] = data.data ?? []
      if (stmts.length === 0) return null
      let latestFY: Record<string,string>|null = null
      let latestNonFY: Record<string,string>|null = null
      for (let j = stmts.length - 1; j >= 0; j--) {
        const s = stmts[j]
        if (s.CurPerType === 'FY' && !latestFY) latestFY = s
        if (s.CurPerType !== 'FY' && s.CurPerType && !latestNonFY) latestNonFY = s
        if (latestFY && latestNonFY) break
      }
      const fy = latestFY ?? stmts[stmts.length - 1]
      const nfy = latestNonFY ?? fy
      const all = stmts
      const shOut = bestVal(all, 'ShOutFY', 'ShOut')
      const equity = bestVal(all,'Eq'), assets = bestVal(all,'TA')
      const sales = bestVal(all,'Sales'), op = bestVal(all,'OP'), np = bestVal(all,'NP')
      const feps = n(nfy.FEPS)||n(fy.FEPS)||bestVal(all,'FEPS')
      const fsales = n(nfy.FSales)||n(fy.FSales)||bestVal(all,'FSales')
      const nySales = n(fy.NxFSales)||n(nfy.NxFSales)||bestVal(all,'NxFSales')
      const fdiv = n(nfy.FDivAnn)||n(nfy.DivAnn)||n(fy.FDivAnn)||n(fy.DivAnn)||bestVal(all,'FDivAnn','DivAnn')
      return {
        fin: {
          sales, op, odp: bestVal(all,'OdP'), np,
          eps: bestVal(all,'EPS'), feps,
          nyEPS: n(fy.NxFEPS)||n(nfy.NxFEPS)||bestVal(all,'NxFEPS'),
          bps: bestVal(all,'BPS'),
          equity, assets, divAnn: bestVal(all,'DivAnn'),
          fdiv, shOut,
          discDate: fy.DiscDate??'', perType: fy.CurPerType??'',
          fsales, fop: n(nfy.FOP)||n(fy.FOP)||bestVal(all,'FOP'),
          nySales, nyOP: n(fy.NxFOP)||n(nfy.NxFOP)||bestVal(all,'NxFOP'),
          roe:      equity ? np/equity : 0,
          eqRat:    assets ? equity/assets : 0,
          opMgn:    sales  ? op/sales : 0,
          salesGr:  (sales&&fsales) ? fsales/sales-1 : 0,
          nySalesGr:(fsales&&nySales) ? nySales/fsales-1 : 0,
        },
        shOut,
      }
    } catch(e: unknown) {
      const status = (e instanceof Error && e.message.includes('429')) ? 429 : 0
      if (status === 429) await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)))
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────
// fetchAllFinancials: 全銘柄を確実に取得
// 戦略1: /fins/summary 一括取得（プレミアムプランのみ）
// 戦略2: 個別直列取得（間隔制御でレート制限回避）
// ─────────────────────────────────────────────────────────────────────
export async function fetchAllFinancials(
  apiKey: string,
  watchlist: string[],
  onProgress?: (done: number, total: number) => void
): Promise<{ finDB: Record<string, FinRecord>; shOutDB: Record<string, number> }> {
  const finDB: Record<string, FinRecord> = {}
  const shOutDB: Record<string, number> = {}

  function bestVal(stmts: Record<string,string>[], ...keys: string[]): number {
    for (const key of keys) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const v = n(stmts[i][key])
        if (v !== 0) return v
      }
    }
    return 0
  }

  function processStmts(code: string, stmts: Record<string,string>[]) {
    if (!stmts || stmts.length === 0) return
    let latestFY: Record<string,string>|null = null
    let latestNonFY: Record<string,string>|null = null
    for (let j = stmts.length - 1; j >= 0; j--) {
      const s = stmts[j]
      if (s.CurPerType==='FY' && !latestFY) latestFY = s
      if (s.CurPerType!=='FY' && s.CurPerType && !latestNonFY) latestNonFY = s
      if (latestFY && latestNonFY) break
    }
    const fy = latestFY ?? stmts[stmts.length-1]
    const nfy = latestNonFY ?? fy
    const all = stmts
    const shOut = bestVal(all,'ShOutFY','ShOut')
    if (shOut > 0) shOutDB[code] = shOut
    const equity=bestVal(all,'Eq'), assets=bestVal(all,'TA')
    const sales=bestVal(all,'Sales'), op=bestVal(all,'OP'), np=bestVal(all,'NP')
    const feps=n(nfy.FEPS)||n(fy.FEPS)||bestVal(all,'FEPS')
    const fsales=n(nfy.FSales)||n(fy.FSales)||bestVal(all,'FSales')
    const nySales=n(fy.NxFSales)||n(nfy.NxFSales)||bestVal(all,'NxFSales')
    const fdiv=n(nfy.FDivAnn)||n(nfy.DivAnn)||n(fy.FDivAnn)||n(fy.DivAnn)||bestVal(all,'FDivAnn','DivAnn')
    finDB[code] = {
      sales,op,odp:bestVal(all,'OdP'),np,
      eps:bestVal(all,'EPS'),feps,nyEPS:n(fy.NxFEPS)||n(nfy.NxFEPS)||bestVal(all,'NxFEPS'),
      bps:bestVal(all,'BPS'),equity,assets,divAnn:bestVal(all,'DivAnn'),
      fdiv,shOut,discDate:fy.DiscDate??'',perType:fy.CurPerType??'',
      fsales,fop:n(nfy.FOP)||n(fy.FOP)||bestVal(all,'FOP'),
      nySales,nyOP:n(fy.NxFOP)||n(nfy.NxFOP)||bestVal(all,'NxFOP'),
      roe:      equity ? np/equity : 0,
      eqRat:    assets ? equity/assets : 0,
      opMgn:    sales  ? op/sales : 0,
      salesGr:  (sales&&fsales) ? fsales/sales-1 : 0,
      nySalesGr:(fsales&&nySales) ? nySales/fsales-1 : 0,
    }
  }

  // ── 戦略1: 一括取得（paginationKey で全ページ）──
  let bulkSuccess = false
  try {
    const wlSet = new Set(watchlist)
    const grouped: Record<string, Record<string,string>[]> = {}
    let paginationKey: string|null = null
    for (let page = 0; page < 30; page++) {
      const path = paginationKey
        ? `/fins/summary?paginationKey=${encodeURIComponent(paginationKey)}`
        : `/fins/summary`
      const res = await jqFetch(path, apiKey)
      const batch: Record<string,string>[] = res.data ?? []
      for (const s of batch) {
        const raw = s.Code ?? ''
        const code = raw.length===5 && raw.endsWith('0') ? raw.slice(0,4) : raw
        if (!wlSet.has(code)) continue
        if (!grouped[code]) grouped[code] = []
        grouped[code].push(s)
      }
      paginationKey = res.pagination_key ?? null
      if (!paginationKey || batch.length === 0) break
      await new Promise(r => setTimeout(r, 200))
    }
    for (const code of watchlist) {
      if (grouped[code]?.length > 0) processStmts(code, grouped[code])
    }
    bulkSuccess = Object.keys(finDB).length > watchlist.length * 0.5 // 50%以上取れたら成功とみなす
  } catch(e) {
    console.warn('[fetchAllFinancials] bulk failed:', e)
  }

  // ── 戦略2: 未取得銘柄を個別直列取得 ──
  const needIndividual = watchlist.filter(c => !finDB[c])
  if (needIndividual.length > 0) {
    if (!bulkSuccess) {
      console.log('[fetchAllFinancials] bulk unavailable, using individual for all', needIndividual.length, 'codes')
    } else {
      console.log('[fetchAllFinancials] individual fetch for missing', needIndividual.length, 'codes')
    }
    let done = watchlist.length - needIndividual.length
    for (const code of needIndividual) {
      // 1件ずつ確実に（失敗したらfetchFinancialOne内でリトライ済み）
      const result = await fetchFinancialOne(apiKey, code)
      if (result) {
        finDB[code] = result.fin
        if (result.shOut > 0) shOutDB[code] = result.shOut
      }
      done++
      onProgress?.(done, watchlist.length)
      // レート制限対策: 1件ごとに300ms待機
      await new Promise(r => setTimeout(r, 300))
    }
  }

  return { finDB, shOutDB }
}


export async function fetchFinancials(
  apiKey: string,
  watchlist: string[]
): Promise<{ finDB: Record<string, FinRecord>; shOutDB: Record<string, number> }> {
  const finDB: Record<string, FinRecord> = {}
  const shOutDB: Record<string, number> = {}

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

  // 並列バッチ取得（BATCH_SIZE件ずつ同時リクエスト）
  const BATCH_SIZE = 8

  async function fetchBatch(codes: string[]): Promise<string[]> {
    const results = await Promise.allSettled(codes.map(code => fetchOne(code)))
    const failed: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)) {
        failed.push(codes[i])
      }
    })
    return failed
  }

  // 全銘柄を並列バッチで取得
  let remaining: string[] = []
  for (let i = 0; i < watchlist.length; i += BATCH_SIZE) {
    const batch = watchlist.slice(i, i + BATCH_SIZE)
    const batchFailed = await fetchBatch(batch)
    remaining.push(...batchFailed)
    // バッチ間に少し待機（レート制限対策）
    if (i + BATCH_SIZE < watchlist.length) {
      await new Promise(r => setTimeout(r, 200))
    }
  }

  // 失敗分を段階的にリトライ（最大5回）
  for (const waitMs of [1000, 2000, 3000, 5000, 8000]) {
    if (remaining.length === 0) break
    console.warn(`[fetchFinancials] retry ${remaining.length} codes after ${waitMs}ms: ${remaining.join(',')}`)
    await new Promise(r => setTimeout(r, waitMs))
    const stillFailed: string[] = []
    for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
      const batch = remaining.slice(i, i + BATCH_SIZE)
      const batchFailed = await fetchBatch(batch)
      stillFailed.push(...batchFailed)
      if (i + BATCH_SIZE < remaining.length) {
        await new Promise(r => setTimeout(r, 300))
      }
    }
    remaining = stillFailed
  }

  if (remaining.length > 0) {
    console.error(`[fetchFinancials] FINAL FAIL: ${remaining.join(',')}`)
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
