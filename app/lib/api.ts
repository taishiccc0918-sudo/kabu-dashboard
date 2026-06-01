import { MasterRecord, PriceRecord, FinRecord } from './types'
import type { DailyClose, FyEps } from './perBand'

// J-Quants MarketCode → 日本語市場名
const MARKET_CODE_MAP: Record<string, string> = {
  '111': 'プライム市場', '0111': 'プライム市場',
  '121': 'スタンダード市場', '0121': 'スタンダード市場',
  '131': 'グロース市場', '0131': 'グロース市場',
  '1':   'プライム市場', '2': 'スタンダード市場', '3': 'グロース市場',
}

async function jqFetch(path: string, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/jquants?path=${encodeURIComponent(path)}`, {
    headers: { 'x-api-key': apiKey }
  })
  if (!res.ok) throw new Error(`${res.status}: ${path}`)
  return res.json()
}

function n(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0
  const num = Number(v)
  return isNaN(num) ? 0 : num
}
function nOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const num = Number(v)
  return isNaN(num) ? null : num
}
function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}
// DiscDate比較用 YYYY-MM-DD 形式（toISOString()のTZずれを避ける）
function cutoffDateStr(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
// FEPS選択: FY確定後でFEPS空欄の場合は次期予想EPS(NxFEPS)にフォールバック
function selectFEPS(
  fy: Record<string,string>,
  nfy: Record<string,string>,
  all: Record<string,string>[],
  bestValOrNullFn: (stmts: Record<string,string>[], ...keys: string[]) => number | null
): number | null {
  const fyFeps = nOrNull(fy.FEPS)
  if (fyFeps !== null) return fyFeps
  // fy.FEPS が空欄かつ fy が nfy より新しい → 通期確定済み → 次期予想EPSを今期として充当
  if (fy.DiscDate && nfy.DiscDate && fy.DiscDate > nfy.DiscDate) return nOrNull(fy.NxFEPS) ?? null
  // nfy のほうが新しい（または同日）→ 四半期予想を継続使用
  return nOrNull(nfy.FEPS) ?? bestValOrNullFn(all, 'FEPS')
}
// 来期EPS選択: FEPS充当(shifted)の場合は来期予想をnullにする（四季報と整合）
function selectNyEPS(
  fy: Record<string,string>,
  nfy: Record<string,string>,
  all: Record<string,string>[],
  bestValOrNullFn: (stmts: Record<string,string>[], ...keys: string[]) => number | null
): { nyEPS: number | null; fepsShifted: boolean } {
  if (nOrNull(fy.FEPS) === null && fy.DiscDate && nfy.DiscDate && fy.DiscDate > nfy.DiscDate) {
    return { nyEPS: null, fepsShifted: true }
  }
  return {
    nyEPS: nOrNull(fy.NxFEPS) ?? nOrNull(nfy.NxFEPS) ?? bestValOrNullFn(all, 'NxFEPS'),
    fepsShifted: false,
  }
}
// 過去時点での最新FEPS: DiscDate < cutoff のレコードのうち最新のFEPSを返す
function getHistoricalFEPS(stmts: Record<string,string>[], daysAgo: number): number | null {
  const cutoff = cutoffDateStr(daysAgo)
  let best: string | null = null
  let bestFeps: number | null = null
  for (const s of stmts) {
    if (!s.DiscDate || s.DiscDate >= cutoff) continue
    const v = nOrNull(s.FEPS)
    if (v === null || v === 0) continue
    if (best === null || s.DiscDate > best) { best = s.DiscDate; bestFeps = v }
  }
  return bestFeps
}

// FY決算ごとのEPS実績ヒストリーを抽出（PERバンド計算用）。
// CurPerType==='FY' かつ EPS>0 のレコードを DiscDate 昇順で、直近5件返す。
export function extractFyEps(stmts: Record<string,string>[]): FyEps[] {
  const byDate = new Map<string, number>()
  for (const s of stmts) {
    if (s.CurPerType !== 'FY' || !s.DiscDate) continue
    const eps = n(s.EPS)
    if (eps > 0) byDate.set(s.DiscDate, eps)  // 同一開示日は後勝ち
  }
  const arr = Array.from(byDate.entries())
    .map(([d, eps]) => ({ d, eps }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  return arr.slice(-5)
}

// 銘柄別のFY EPS実績ヒストリーを単独取得（PERバンドのカバレッジ補完用）。
// 一括取得では過去履歴が足りない銘柄向けに、code指定で全開示履歴を引いて抽出する。
export async function fetchFyEpsForCode(code: string, apiKey: string): Promise<FyEps[]> {
  const data = await jqFetch(`/fins/summary?code=${code}`, apiKey)
  const stmts: Record<string,string>[] = (data as { data?: Record<string,string>[] }).data ?? []
  return extractFyEps(stmts)
}

// 銘柄別の日次株価（調整後終値）をレンジ取得（PERバンド／チャート共用）。
// fromStr/toStr は 'YYYYMMDD' 形式。調整後終値(AdjC)優先、なければ終値(C)。
export async function fetchDailyBars(
  code: string, fromStr: string, toStr: string, apiKey: string
): Promise<DailyClose[]> {
  const data = await jqFetch(
    `/equities/bars/daily?code=${code}&dateFrom=${fromStr}&dateTo=${toStr}`, apiKey
  )
  const rows = (data as { data?: Record<string, unknown>[] }).data ?? []
  const fromISO = `${fromStr.slice(0,4)}-${fromStr.slice(4,6)}-${fromStr.slice(6,8)}`
  const out: DailyClose[] = []
  for (const d of rows) {
    const date = (d.Date as string) ?? ''
    if (!date || date < fromISO) continue  // APIが余分な過去を返す場合に備える
    const price = n(d.AdjC) || n(d.C)
    if (price > 0) out.push({ date, price })
  }
  return out
}

export async function findLatestBizDate(apiKey: string): Promise<{ dateStr: string; dateDisp: string }> {
  const today = new Date()
  for (let i = 0; i < 10; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const day = d.getDay()
    if (day === 0 || day === 6) continue
    const yyyymmdd = localDateStr(d)
    try {
      const data = await jqFetch(`/equities/bars/daily?date=${yyyymmdd}&includeAUSession=false`, apiKey)
      const rows = (data as { data?: unknown[] }).data ?? []
      if (Array.isArray(rows) && rows.length > 0) {
        const disp = `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`
        return { dateStr: yyyymmdd, dateDisp: disp }
      }
    } catch { continue }
  }
  const fallback = new Date(today)
  fallback.setDate(fallback.getDate() - 2)
  const s = localDateStr(fallback)
  return { dateStr: s, dateDisp: `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` }
}

export async function fetchMaster(
  apiKey: string,         // 互換性のため残す（JPX方式では未使用）
  watchlist: string[],
  onProgress?: (done: number, total: number) => void
): Promise<Record<string, MasterRecord>> {
  const db: Record<string, MasterRecord> = {}
  try {
    onProgress?.(0, watchlist.length)
    const res = await fetch('/api/listed-info')
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(`/api/listed-info: ${res.status} ${body.error ?? ''}`)
    }
    const data = await res.json() as Record<string, { name: string; market: string }>
    for (const [code, rec] of Object.entries(data)) {
      if (rec.name && rec.market) db[code] = { name: rec.name, market: rec.market }
    }
    const missing = watchlist.filter(c => !db[c])
    console.log(`[fetchMaster] JPX: ${Object.keys(db).length} companies loaded, missing: ${missing.length}`)
    if (missing.length > 0) console.warn(`[fetchMaster] not in JPX: ${missing.join(', ')}`)
  } catch (e) {
    console.warn('[fetchMaster] failed:', e)
  }
  onProgress?.(watchlist.length, watchlist.length)
  return db
}

async function fetchPastDate(baseDate: string, daysBack: number, rangeDays: number, apiKey: string): Promise<string | null> {
  const base = new Date(parseInt(baseDate.slice(0,4)), parseInt(baseDate.slice(4,6))-1, parseInt(baseDate.slice(6,8)))
  const target = new Date(base)
  target.setDate(target.getDate() - daysBack)
  for (let offset = 0; offset <= rangeDays; offset++) {
    const d = new Date(target)
    d.setDate(d.getDate() - offset)
    if (d.getDay() === 0 || d.getDay() === 6) continue
    const candidate = localDateStr(d)
    try {
      const data = await jqFetch(`/equities/bars/daily?date=${candidate}&includeAUSession=false`, apiKey)
      const rows = (data as { data?: unknown[] }).data ?? []
      if (rows.length > 0) return candidate
    } catch { continue }
  }
  return null
}

export async function fetchPrices(
  apiKey: string,
  watchlistOrDate: string[] | string,
  latestDateArg?: string,
  onProgress?: (msg: string) => void
): Promise<Record<string, PriceRecord>> {
  const watchlist: string[] = Array.isArray(watchlistOrDate) ? watchlistOrDate : []
  const latestDate: string = Array.isArray(watchlistOrDate) ? (latestDateArg ?? '') : watchlistOrDate
  const db: Record<string, PriceRecord> = {}
  const wlSet = new Set(watchlist)
  onProgress?.('株価データ取得中...')
  const [d1w, d1m, d3m, d1y, prevDate] = await Promise.all([
    fetchPastDate(latestDate, 7, 7, apiKey),
    fetchPastDate(latestDate, 30, 7, apiKey),
    fetchPastDate(latestDate, 90, 7, apiKey),
    fetchPastDate(latestDate, 365, 7, apiKey),
    fetchPastDate(latestDate, 1, 3, apiKey),
  ])
  const allDates = [latestDate, prevDate, d1w, d1m, d3m, d1y].filter(Boolean) as string[]
  const uniqueDates = Array.from(new Set(allDates))
  const results = await Promise.all(
    uniqueDates.map(async (date) => {
      try {
        const data = await jqFetch(`/equities/bars/daily?date=${date}&includeAUSession=false`, apiKey)
        const rows = (data as { data?: Record<string,string>[] }).data ?? []
        const map: Record<string, number> = {}
        for (const row of rows) {
          const raw = row.Code ?? ''
          const code = raw.length === 5 && raw.endsWith('0') ? raw.slice(0,4) : raw
          if (!wlSet.has(code)) continue
          const close = n(row.AdjC) || n(row.C)
          if (close > 0) map[code] = close
        }
        return { date, map }
      } catch { return { date, map: {} } }
    })
  )
  const byDate: Record<string, Record<string, number>> = {}
  for (const r of results) byDate[r.date] = r.map
  for (const code of watchlist) {
    const close = byDate[latestDate]?.[code] ?? 0
    const prev1d = prevDate ? (byDate[prevDate]?.[code] ?? 0) : 0
    const prev1w = d1w ? (byDate[d1w]?.[code] ?? 0) : 0
    const prev1m = d1m ? (byDate[d1m]?.[code] ?? 0) : 0
    const prev3m = d3m ? (byDate[d3m]?.[code] ?? 0) : 0
    const prev1y = d1y ? (byDate[d1y]?.[code] ?? 0) : 0
    const chg = (a: number, b: number): number | undefined => (a > 0 && b > 0) ? (a/b - 1) : undefined
    db[code] = {
      close, mcap: 0,
      chg1d: chg(close, prev1d),
      chg1w: chg(close, prev1w),
      chg3m: chg(close, prev3m),
      chg1y: chg(close, prev1y),
      prev1m, prev1w, prev3m, prev1y,
    }
  }
  return db
}

export async function fetchAnnouncements(apiKey: string, watchlist: string[]): Promise<Record<string, string>> {
  const db: Record<string, string> = {}
  const wlSet = new Set(watchlist)
  try {
    const data = await jqFetch('/fins/announcement', apiKey) as { announcement?: Record<string,string>[] }
    for (const row of data.announcement ?? []) {
      const raw = row.Code ?? ''
      const code = raw.length === 5 && raw.endsWith('0') ? raw.slice(0,4) : raw
      if (!wlSet.has(code)) continue
      const date = row.AnnouncementDate ?? row.Date ?? ''
      if (date) db[code] = date
    }
  } catch(e: unknown) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.startsWith('403')) {
      console.warn('⚠️ J-Quants Lightプランでは決算予定日(announcement)が取得できません。次決算日のチェックは手動で行ってください。')
    } else if (msg) {
      console.warn('[fetchAnnouncements] failed:', msg)
    }
  }
  return db
}

type FinResult = { fin: FinRecord; shOut: number }

export async function fetchFinancialOne(apiKey: string, code: string): Promise<FinResult | null> {
  function bestVal(stmts: Record<string,string>[], ...keys: string[]): number {
    for (const key of keys) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const v = n(stmts[i][key]); if (v !== 0) return v
      }
    }
    return 0
  }
  function bestValOrNull(stmts: Record<string,string>[], ...keys: string[]): number | null {
    for (const key of keys) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const v = nOrNull(stmts[i][key])
        if (v !== null && v !== 0) return v
      }
    }
    return null
  }
  // 429専用バックオフ: 2秒→5秒→10秒→20秒
  const retryWaits429 = [2000, 5000, 10000, 20000]
  let retry429 = 0
  for (;;) {
    try {
      const data = await jqFetch(`/fins/summary?code=${code}`, apiKey)
      const stmts: Record<string,string>[] = (data as { data?: Record<string,string>[] }).data ?? []
      if (stmts.length === 0) return null
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
      const fyVal = (...keys: string[]) => { for (const k of keys) { const v = n(fy[k]); if (v !== 0) return v } return 0 }
      const shOut = bestVal(all,'ShOutFY','ShOut')
      const equity = fyVal('Eq')    || bestVal(all,'Eq')
      const assets = fyVal('TA')    || bestVal(all,'TA')
      const sales  = fyVal('Sales') || bestVal(all,'Sales')
      const op     = fyVal('OP')    || bestVal(all,'OP')
      const np     = fyVal('NP')    || bestVal(all,'NP')
      const feps = selectFEPS(fy, nfy, all, bestValOrNull)
      const { nyEPS, fepsShifted } = selectNyEPS(fy, nfy, all, bestValOrNull)
      const eps = fyVal('EPS') || bestVal(all, 'EPS')
      const fsales=n(fy.FSales)||n(nfy.FSales)||bestVal(all,'FSales')
      const nySalesRaw=nOrNull(fy.NxFSales)??nOrNull(nfy.NxFSales)??bestValOrNull(all,'NxFSales')
      const nySales=nySalesRaw??0
      const fdiv=n(fy.FDivAnn)||n(fy.DivAnn)||n(nfy.FDivAnn)||n(nfy.DivAnn)||bestVal(all,'FDivAnn','DivAnn')
      return {
        fin: {
          sales,op,odp:bestVal(all,'OdP'),np,eps,feps,nyEPS,
          bps:fyVal('BPS')||bestVal(all,'BPS'),equity,assets,divAnn:bestVal(all,'DivAnn'),
          fdiv,shOut,discDate:fy.DiscDate??'',perType:fy.CurPerType??'',
          fsales,fop:n(nfy.FOP)||n(fy.FOP)||bestVal(all,'FOP'),
          nySales,nyOP:n(fy.NxFOP)||n(nfy.NxFOP)||bestVal(all,'NxFOP'),
          roe:(equity&&np)?np/equity:null, eqRat:assets?equity/assets:0,
          opMgn:(sales&&op)?op/sales:null,
          salesGr:(sales&&fsales)?fsales/sales-1:0,
          nySalesGr:(sales&&nySalesRaw!=null)?nySalesRaw/sales-1:null,
          feps1m: getHistoricalFEPS(all, 30),
          fepsShifted,
          fyEps: extractFyEps(all),
        },
        shOut,
      }
    } catch(e: unknown) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.startsWith('429') && retry429 < retryWaits429.length) {
        const wait = retryWaits429[retry429]
        console.warn(`[fetchFinancialOne] ${code} 429レート制限 → ${wait/1000}秒待機 (${retry429+1}/${retryWaits429.length}回目)`)
        await new Promise(r => setTimeout(r, wait))
        retry429++
        continue
      }
      console.warn(`[fetchFinancialOne] ${code} 取得失敗: ${msg}`)
      return null
    }
  }
}

export async function fetchAllFinancials(
  apiKey: string, watchlist: string[],
  onProgress?: (done: number, total: number) => void,
  onStatus?: (msg: string) => void,
  abortSignal?: { aborted: boolean }
): Promise<{ finDB: Record<string, FinRecord>; shOutDB: Record<string, number>; aborted?: boolean }> {
  const finDB: Record<string, FinRecord> = {}
  const shOutDB: Record<string, number> = {}

  function bestVal(stmts: Record<string,string>[], ...keys: string[]): number {
    for (const key of keys) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const v = n(stmts[i][key]); if (v !== 0) return v
      }
    }
    return 0
  }
  function bestValOrNull(stmts: Record<string,string>[], ...keys: string[]): number | null {
    for (const key of keys) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        const v = nOrNull(stmts[i][key])
        if (v !== null && v !== 0) return v
      }
    }
    return null
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
    const fyVal = (...keys: string[]) => { for (const k of keys) { const v = n(fy[k]); if (v !== 0) return v } return 0 }
    const shOut = bestVal(all,'ShOutFY','ShOut')
    if (shOut > 0) shOutDB[code] = shOut
    const equity = fyVal('Eq')    || bestVal(all,'Eq')
    const assets = fyVal('TA')    || bestVal(all,'TA')
    const sales  = fyVal('Sales') || bestVal(all,'Sales')
    const op     = fyVal('OP')    || bestVal(all,'OP')
    const np     = fyVal('NP')    || bestVal(all,'NP')
    const feps = selectFEPS(fy, nfy, all, bestValOrNull)
    const { nyEPS, fepsShifted } = selectNyEPS(fy, nfy, all, bestValOrNull)
    const eps = fyVal('EPS') || bestVal(all, 'EPS')
    const fsales=n(fy.FSales)||n(nfy.FSales)||bestVal(all,'FSales')
    const nySalesRaw=nOrNull(fy.NxFSales)??nOrNull(nfy.NxFSales)??bestValOrNull(all,'NxFSales')
    const nySales=nySalesRaw??0
    const fdiv=n(fy.FDivAnn)||n(fy.DivAnn)||n(nfy.FDivAnn)||n(nfy.DivAnn)||bestVal(all,'FDivAnn','DivAnn')
    finDB[code] = {
      sales,op,odp:bestVal(all,'OdP'),np,
      eps,feps,nyEPS,
      bps:fyVal('BPS')||bestVal(all,'BPS'),equity,assets,divAnn:bestVal(all,'DivAnn'),
      fdiv,shOut,discDate:fy.DiscDate??'',perType:fy.CurPerType??'',
      fsales,fop:n(nfy.FOP)||n(fy.FOP)||bestVal(all,'FOP'),
      nySales,nyOP:n(fy.NxFOP)||n(nfy.NxFOP)||bestVal(all,'NxFOP'),
      roe:(equity&&np)?np/equity:null, eqRat:assets?equity/assets:0,
      opMgn:(sales&&op)?op/sales:null,
      salesGr:(sales&&fsales)?fsales/sales-1:0,
      nySalesGr:(sales&&nySalesRaw!=null)?nySalesRaw/sales-1:null,
      feps1m: getHistoricalFEPS(all, 30),
      fepsShifted,
      fyEps: extractFyEps(all),
    }
  }

  // 戦略1: 一括取得 (J-Quants Lightプランではcodeなし呼び出しが400になる場合あり → 失敗しても続行)
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
      const batch: Record<string,string>[] = (res as { data?: Record<string,string>[] }).data ?? []
      for (const s of batch) {
        const raw = s.Code ?? ''
        const code = raw.length===5 && raw.endsWith('0') ? raw.slice(0,4) : raw
        if (!wlSet.has(code)) continue
        if (!grouped[code]) grouped[code] = []
        grouped[code].push(s)
      }
      paginationKey = (res as { pagination_key?: string }).pagination_key ?? null
      if (!paginationKey || batch.length === 0) break
      await new Promise(r => setTimeout(r, 100))
    }
    for (const code of watchlist) {
      if (grouped[code]?.length > 0) processStmts(code, grouped[code])
    }
    bulkSuccess = Object.keys(finDB).length > watchlist.length * 0.5
  } catch(e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith('400')) {
      console.info('[fetchAllFinancials] 一括取得(codeなし)は非対応 → 個別取得に切替')
    } else {
      console.warn('[fetchAllFinancials] bulk failed:', e)
    }
  }

  // 戦略2: 並列個別取得（8件並列・固定sleep廃止 → 429バックオフに委ねる）
  const needIndividual = watchlist.filter(c => !finDB[c])
  if (needIndividual.length > 0) {
    console.log(`[fetchAllFinancials] 個別取得: ${needIndividual.length}件 (並列8, bulk=${bulkSuccess})`)
    let done = watchlist.length - needIndividual.length
    const CONCURRENCY = 8
    for (let i = 0; i < needIndividual.length; i += CONCURRENCY) {
      if (abortSignal?.aborted) return { finDB, shOutDB, aborted: true }
      const batch = needIndividual.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(code => fetchFinancialOne(apiKey, code)))
      for (let j = 0; j < batch.length; j++) {
        const r = results[j]
        if (r) { finDB[batch[j]] = r.fin; if (r.shOut > 0) shOutDB[batch[j]] = r.shOut }
      }
      done += batch.length
      onProgress?.(done, watchlist.length)
    }
  }

  // 戦略3: リトライ（8秒待機後・逐次・1.5秒間隔）
  if (abortSignal?.aborted) return { finDB, shOutDB, aborted: true }
  const stillMissing = watchlist.filter(c => !finDB[c])
  if (stillMissing.length > 0) {
    console.warn(`[fetchAllFinancials] リトライ対象: ${stillMissing.join(', ')}`)
    onStatus?.(`⏳ リトライ中 (残${stillMissing.length}銘柄)… 3秒待機`)
    await new Promise(r => setTimeout(r, 3000))
    for (let i = 0; i < stillMissing.length; i++) {
      const code = stillMissing[i]
      onStatus?.(`⏳ リトライ中 (残${stillMissing.length - i}銘柄)`)
      const result = await fetchFinancialOne(apiKey, code)
      if (result) { finDB[code] = result.fin; if (result.shOut > 0) shOutDB[code] = result.shOut }
      if (i + 1 < stillMissing.length) await new Promise(r => setTimeout(r, 500))
    }
  }

  // 戦略4: 最終リトライ（12秒待機後・逐次・2秒間隔）
  const finalRetry = watchlist.filter(c => !finDB[c])
  if (finalRetry.length > 0) {
    console.warn(`[fetchAllFinancials] 最終リトライ対象: ${finalRetry.join(', ')}`)
    onStatus?.(`⏳ 最終リトライ (残${finalRetry.length}銘柄)… 5秒待機`)
    await new Promise(r => setTimeout(r, 5000))
    for (let i = 0; i < finalRetry.length; i++) {
      const code = finalRetry[i]
      onStatus?.(`⏳ 最終リトライ (残${finalRetry.length - i}銘柄)`)
      const result = await fetchFinancialOne(apiKey, code)
      if (result) { finDB[code] = result.fin; if (result.shOut > 0) shOutDB[code] = result.shOut }
      if (i + 1 < finalRetry.length) await new Promise(r => setTimeout(r, 1000))
    }
  }

  const ultimateMissing = watchlist.filter(c => !finDB[c])
  if (ultimateMissing.length > 0) {
    console.warn(`[fetchAllFinancials] 最終的に取得できなかった銘柄 (${ultimateMissing.length}件): ${ultimateMissing.join(', ')}`)
  } else {
    console.log('[fetchAllFinancials] 全銘柄の財務データ取得完了')
  }

  return { finDB, shOutDB }
}

export async function fetchFinancials(
  apiKey: string, watchlist: string[],
  onProgress?: (done: number, total: number) => void,
  onStatus?: (msg: string) => void
): Promise<{ finDB: Record<string, FinRecord>; shOutDB: Record<string, number> }> {
  return fetchAllFinancials(apiKey, watchlist, onProgress, onStatus)
}
