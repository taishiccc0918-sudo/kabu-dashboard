import { MasterRecord, PriceRecord, FinRecord } from './types'

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

export async function findLatestBizDate(apiKey: string): Promise<{ dateStr: string; dateDisp: string }> {
  const today = new Date()
  for (let i = 0; i < 10; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const day = d.getDay()
    if (day === 0 || day === 6) continue
    const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, '')
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
  const s = fallback.toISOString().slice(0, 10).replace(/-/g, '')
  return { dateStr: s, dateDisp: `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` }
}

export async function fetchMaster(apiKey: string, watchlistForDebug?: string[]): Promise<Record<string, MasterRecord>> {
  const db: Record<string, MasterRecord> = {}
  function processRows(rows: Record<string, string>[]) {
    for (const row of rows) {
      const raw = row.Code ?? ''
      const code = raw.length === 5 && raw.endsWith('0') ? raw.slice(0, 4) : raw
      if (!code) continue
      const rawMarket = String(row.MarketCode ?? row.Market ?? '')
      const name = row.CompanyName ?? row.CompanyNameEnglish ?? row.CompanyNameEn ?? ''
      db[code] = {
        name,
        market: MARKET_CODE_MAP[rawMarket] ?? rawMarket,
      }
    }
  }
  try {
    let paginationKey: string | null = null
    for (let page = 0; page < 20; page++) {
      const path = paginationKey
        ? `/listed/info?paginationKey=${encodeURIComponent(paginationKey)}`
        : '/listed/info'
      const data = await jqFetch(path, apiKey)

      // 診断ログ (ページ0のみ)
      if (page === 0) {
        const responseKeys = Object.keys(data as object)
        console.log('[fetchMaster] page0 responseKeys:', responseKeys)
        const anyRows = (data as Record<string, unknown[]>)[responseKeys[0]] ?? []
        if (Array.isArray(anyRows) && anyRows.length > 0) {
          const firstRow = anyRows[0] as Record<string, unknown>
          console.log('[fetchMaster] page0 firstRow keys:', Object.keys(firstRow))
          console.log('[fetchMaster] page0 firstRow sample:', JSON.stringify(firstRow).slice(0, 300))
        } else {
          console.warn('[fetchMaster] page0 rows empty! raw response:', JSON.stringify(data).slice(0, 500))
        }
      }

      const rows = (data as { info?: Record<string, string>[] }).info
                ?? (data as { listed_info?: Record<string, string>[] }).listed_info
                ?? (data as { equities?: Record<string, string>[] }).equities
                ?? []
      processRows(rows as Record<string, string>[])
      paginationKey = (data as { pagination_key?: string }).pagination_key ?? null
      if (!paginationKey || rows.length === 0) break
    }

    const sampleCodes = watchlistForDebug?.slice(0, 5) ?? ['8729', '7003', '290A', '6758', '7974']
    const sampleOut: Record<string, string> = {}
    for (const c of sampleCodes) if (db[c]) sampleOut[c] = db[c].name
    console.log(`[fetchMaster] loaded ${Object.keys(db).length} companies | watchlist samples:`, sampleOut)
  } catch(e) { console.warn('[fetchMaster] failed:', e) }
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
    const yyyymmdd = d.toISOString().slice(0,10).replace(/-/g,'')
    try {
      const data = await jqFetch(`/equities/bars/daily?date=${yyyymmdd}&includeAUSession=false`, apiKey)
      const rows = (data as { data?: unknown[] }).data ?? []
      if (Array.isArray(rows) && rows.length > 0) return yyyymmdd
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
    fetchPastDate(latestDate, 1, 5, apiKey),
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
          const close = n(row.AdjC) || n(row.C) || n(row.Close) || n(row.AdjustmentClose)
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
      const shOut = bestVal(all,'ShOutFY','ShOut')
      const equity=bestVal(all,'Eq'), assets=bestVal(all,'TA')
      const sales=bestVal(all,'Sales'), op=bestVal(all,'OP'), np=bestVal(all,'NP')
      const feps=n(fy.FEPS)||n(nfy.FEPS)||bestVal(all,'FEPS')
      const fsales=n(fy.FSales)||n(nfy.FSales)||bestVal(all,'FSales')
      const nySales=n(fy.NxFSales)||n(nfy.NxFSales)||bestVal(all,'NxFSales')
      const fdiv=n(fy.FDivAnn)||n(fy.DivAnn)||n(nfy.FDivAnn)||n(nfy.DivAnn)||bestVal(all,'FDivAnn','DivAnn')
      return {
        fin: {
          sales,op,odp:bestVal(all,'OdP'),np,eps:bestVal(all,'EPS'),feps,
          nyEPS:n(fy.NxFEPS)||n(nfy.NxFEPS)||bestVal(all,'NxFEPS'),
          bps:bestVal(all,'BPS'),equity,assets,divAnn:bestVal(all,'DivAnn'),
          fdiv,shOut,discDate:fy.DiscDate??'',perType:fy.CurPerType??'',
          fsales,fop:n(nfy.FOP)||n(fy.FOP)||bestVal(all,'FOP'),
          nySales,nyOP:n(fy.NxFOP)||n(nfy.NxFOP)||bestVal(all,'NxFOP'),
          roe:equity?np/equity:0, eqRat:assets?equity/assets:0,
          opMgn:sales?op/sales:0,
          salesGr:(sales&&fsales)?fsales/sales-1:0,
          nySalesGr:(fsales&&nySales)?nySales/fsales-1:0,
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
  onStatus?: (msg: string) => void
): Promise<{ finDB: Record<string, FinRecord>; shOutDB: Record<string, number> }> {
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
    const feps=n(fy.FEPS)||n(nfy.FEPS)||bestVal(all,'FEPS')
    const fsales=n(fy.FSales)||n(nfy.FSales)||bestVal(all,'FSales')
    const nySales=n(fy.NxFSales)||n(nfy.NxFSales)||bestVal(all,'NxFSales')
    const fdiv=n(fy.FDivAnn)||n(fy.DivAnn)||n(nfy.FDivAnn)||n(nfy.DivAnn)||bestVal(all,'FDivAnn','DivAnn')
    finDB[code] = {
      sales,op,odp:bestVal(all,'OdP'),np,
      eps:bestVal(all,'EPS'),feps,nyEPS:n(fy.NxFEPS)||n(nfy.NxFEPS)||bestVal(all,'NxFEPS'),
      bps:bestVal(all,'BPS'),equity,assets,divAnn:bestVal(all,'DivAnn'),
      fdiv,shOut,discDate:fy.DiscDate??'',perType:fy.CurPerType??'',
      fsales,fop:n(nfy.FOP)||n(fy.FOP)||bestVal(all,'FOP'),
      nySales,nyOP:n(fy.NxFOP)||n(nfy.NxFOP)||bestVal(all,'NxFOP'),
      roe:equity?np/equity:0, eqRat:assets?equity/assets:0,
      opMgn:sales?op/sales:0,
      salesGr:(sales&&fsales)?fsales/sales-1:0,
      nySalesGr:(fsales&&nySales)?nySales/fsales-1:0,
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
      await new Promise(r => setTimeout(r, 500))
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

  // 戦略2: 個別取得（逐次・1件ずつ・1秒間隔 ← 429対策）
  const needIndividual = watchlist.filter(c => !finDB[c])
  if (needIndividual.length > 0) {
    console.log(`[fetchAllFinancials] 個別取得: ${needIndividual.length}件 (bulk=${bulkSuccess})`)
    let done = watchlist.length - needIndividual.length
    for (let i = 0; i < needIndividual.length; i++) {
      const code = needIndividual[i]
      const result = await fetchFinancialOne(apiKey, code)
      if (result) {
        finDB[code] = result.fin
        if (result.shOut > 0) shOutDB[code] = result.shOut
      }
      done++
      onProgress?.(done, watchlist.length)
      if (i + 1 < needIndividual.length) await new Promise(r => setTimeout(r, 1000))
    }
  }

  // 戦略3: リトライ（20秒待機後・逐次・2秒間隔）
  const stillMissing = watchlist.filter(c => !finDB[c])
  if (stillMissing.length > 0) {
    console.warn(`[fetchAllFinancials] リトライ対象: ${stillMissing.join(', ')}`)
    onStatus?.(`⏳ リトライ中 (残${stillMissing.length}銘柄)… 20秒待機します`)
    await new Promise(r => setTimeout(r, 20000))
    for (let i = 0; i < stillMissing.length; i++) {
      const code = stillMissing[i]
      onStatus?.(`⏳ リトライ中 (残${stillMissing.length - i}銘柄)`)
      const result = await fetchFinancialOne(apiKey, code)
      if (result) {
        finDB[code] = result.fin
        if (result.shOut > 0) shOutDB[code] = result.shOut
      }
      if (i + 1 < stillMissing.length) await new Promise(r => setTimeout(r, 2000))
    }
  }

  // 戦略4: 最終リトライ（30秒待機後・逐次・3秒間隔）
  const finalRetry = watchlist.filter(c => !finDB[c])
  if (finalRetry.length > 0) {
    console.warn(`[fetchAllFinancials] 最終リトライ対象: ${finalRetry.join(', ')}`)
    onStatus?.(`⏳ 最終リトライ中 (残${finalRetry.length}銘柄)… 30秒待機します`)
    await new Promise(r => setTimeout(r, 30000))
    for (let i = 0; i < finalRetry.length; i++) {
      const code = finalRetry[i]
      onStatus?.(`⏳ 最終リトライ中 (残${finalRetry.length - i}銘柄)`)
      const result = await fetchFinancialOne(apiKey, code)
      if (result) {
        finDB[code] = result.fin
        if (result.shOut > 0) shOutDB[code] = result.shOut
      }
      if (i + 1 < finalRetry.length) await new Promise(r => setTimeout(r, 3000))
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
