/**
 * Phase3 エンジン: 全銘柄をJ-Quantsから取得→指標/PERバンドを計算→Supabaseに保存。
 * GitHub Actions（日次cron＋手動）から `npx tsx scripts/refresh.ts` で実行する。
 *
 * 必要な環境変数（GitHub Secrets / ローカル.env）:
 *   JQUANTS_API_KEY            … J-Quants の x-api-key（アプリと同じ）
 *   SUPABASE_URL               … 例 https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  … Supabase の service_role キー（RLSをバイパスして書き込み）
 *
 * クライアントの計算と整合させるため、純粋関数（buildPerBand / extractFyEps）は
 * アプリ本体から import して共有する。財務レコードの組み立てだけ Node 用に移植。
 */
import { createClient } from '@supabase/supabase-js'
import { buildPerBand, type DailyClose, type FyEps } from '../app/lib/perBand'
import { extractFyEps } from '../app/lib/api'

const JQ_BASE = 'https://api.jquants.com/v2'
const API_KEY = process.env.JQUANTS_API_KEY ?? ''
const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const FALLBACK_WATCHLIST = ['7203', '8306', '8058']
const CONCURRENCY = 4

if (!API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('必須の環境変数が未設定です（JQUANTS_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ── 小道具 ────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function n(v: unknown): number { if (v == null || v === '') return 0; const x = Number(v); return isNaN(x) ? 0 : x }
function nOrNull(v: unknown): number | null { if (v == null || v === '') return null; const x = Number(v); return isNaN(x) ? null : x }
function ymd(d: Date): string { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}` }
function iso(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
function cutoffDateStr(daysAgo: number): string { const d = new Date(); d.setDate(d.getDate() - daysAgo); return iso(d) }

// J-Quants 直接取得（x-api-key・429バックオフ）
async function jq(path: string): Promise<Record<string, unknown>> {
  const waits = [2000, 5000, 10000, 20000]
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${JQ_BASE}${path}`, { headers: { 'x-api-key': API_KEY } })
    if (res.ok) return res.json() as Promise<Record<string, unknown>>
    if (res.status === 429 && attempt < waits.length) { await sleep(waits[attempt]); continue }
    throw new Error(`${res.status}: ${path}`)
  }
}

// ── 財務レコード組み立て（app/lib/api.ts の processStmts を移植）──────────
function bestVal(stmts: Record<string,string>[], ...keys: string[]): number {
  for (const k of keys) for (let i = stmts.length - 1; i >= 0; i--) { const v = n(stmts[i][k]); if (v !== 0) return v }
  return 0
}
function bestValOrNull(stmts: Record<string,string>[], ...keys: string[]): number | null {
  for (const k of keys) for (let i = stmts.length - 1; i >= 0; i--) { const v = nOrNull(stmts[i][k]); if (v !== null && v !== 0) return v }
  return null
}
function getHistoricalFEPS(stmts: Record<string,string>[], daysAgo: number): number | null {
  const cutoff = cutoffDateStr(daysAgo); let best: string | null = null; let bestFeps: number | null = null
  for (const s of stmts) {
    if (!s.DiscDate || s.DiscDate >= cutoff) continue
    const v = nOrNull(s.FEPS); if (v === null || v === 0) continue
    if (best === null || s.DiscDate > best) { best = s.DiscDate; bestFeps = v }
  }
  return bestFeps
}
function selectFEPS(fy: Record<string,string>, nfy: Record<string,string>, all: Record<string,string>[]): number | null {
  const fyFeps = nOrNull(fy.FEPS); if (fyFeps !== null) return fyFeps
  if (fy.DiscDate && nfy.DiscDate && fy.DiscDate > nfy.DiscDate) return nOrNull(fy.NxFEPS) ?? null
  return nOrNull(nfy.FEPS) ?? bestValOrNull(all, 'FEPS')
}
function selectNyEPS(fy: Record<string,string>, nfy: Record<string,string>, all: Record<string,string>[]): { nyEPS: number | null; fepsShifted: boolean } {
  if (nOrNull(fy.FEPS) === null && fy.DiscDate && nfy.DiscDate && fy.DiscDate > nfy.DiscDate) return { nyEPS: null, fepsShifted: true }
  return { nyEPS: nOrNull(fy.NxFEPS) ?? nOrNull(nfy.NxFEPS) ?? bestValOrNull(all, 'NxFEPS'), fepsShifted: false }
}

function buildFin(stmts: Record<string,string>[]) {
  if (!stmts || stmts.length === 0) return null
  let latestFY: Record<string,string>|null = null, latestNonFY: Record<string,string>|null = null
  for (let j = stmts.length - 1; j >= 0; j--) {
    const s = stmts[j]
    if (s.CurPerType === 'FY' && !latestFY) latestFY = s
    if (s.CurPerType !== 'FY' && s.CurPerType && !latestNonFY) latestNonFY = s
    if (latestFY && latestNonFY) break
  }
  const fy = latestFY ?? stmts[stmts.length-1]
  const nfy = latestNonFY ?? fy
  const all = stmts
  const fyVal = (...keys: string[]) => { for (const k of keys) { const v = n(fy[k]); if (v !== 0) return v } return 0 }
  const shOut = bestVal(all, 'ShOutFY', 'ShOut')
  const equity = fyVal('Eq') || bestVal(all,'Eq')
  const assets = fyVal('TA') || bestVal(all,'TA')
  const sales  = fyVal('Sales') || bestVal(all,'Sales')
  const op     = fyVal('OP') || bestVal(all,'OP')
  const np     = fyVal('NP') || bestVal(all,'NP')
  const feps = selectFEPS(fy, nfy, all)
  const { nyEPS, fepsShifted } = selectNyEPS(fy, nfy, all)
  const eps = fyVal('EPS') || bestVal(all,'EPS')
  const fsales = n(fy.FSales) || n(nfy.FSales) || bestVal(all,'FSales')
  const nySalesRaw = nOrNull(fy.NxFSales) ?? nOrNull(nfy.NxFSales) ?? bestValOrNull(all,'NxFSales')
  const nySales = nySalesRaw ?? 0
  const fdiv = n(fy.FDivAnn) || n(fy.DivAnn) || n(nfy.FDivAnn) || n(nfy.DivAnn) || bestVal(all,'FDivAnn','DivAnn')
  const fin = {
    sales, op, odp: bestVal(all,'OdP'), np, eps, feps, nyEPS,
    bps: fyVal('BPS') || bestVal(all,'BPS'), equity, assets, divAnn: bestVal(all,'DivAnn'),
    fdiv, shOut, discDate: fy.DiscDate ?? '', perType: fy.CurPerType ?? '',
    fsales, fop: n(nfy.FOP) || n(fy.FOP) || bestVal(all,'FOP'),
    nySales, nyOP: n(fy.NxFOP) || n(nfy.NxFOP) || bestVal(all,'NxFOP'),
    roe: (equity && np) ? np / equity : null, eqRat: assets ? equity / assets : 0,
    opMgn: (sales && op) ? op / sales : null,
    salesGr: (sales && fsales) ? fsales / sales - 1 : 0,
    nySalesGr: (sales && nySalesRaw != null) ? nySalesRaw / sales - 1 : null,
    feps1m: getHistoricalFEPS(all, 30),
    fepsShifted,
    fyEps: extractFyEps(all) as FyEps[],
  }
  return { fin, shOut }
}

// ── 日次株価（1年強）取得 → DailyClose[] ────────────────────
async function fetchDaily(code: string, fromStr: string, toStr: string): Promise<DailyClose[]> {
  const data = await jq(`/equities/bars/daily?code=${code}&dateFrom=${fromStr}&dateTo=${toStr}`)
  const rows = (data as { data?: Record<string, unknown>[] }).data ?? []
  const out: DailyClose[] = []
  for (const d of rows) {
    const date = (d.Date as string) ?? ''
    const price = n(d.AdjC) || n(d.C)
    if (date && price > 0) out.push({ date, price })
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return out
}

function minusDaysISO(dateStr: string, days: number): string {
  const [y,m,d] = dateStr.split('-').map(Number)
  const t = Date.UTC(y, m-1, d) - days*86400000
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`
}

// 日次系列から PriceRecord 相当を作る
function buildPrice(daily: DailyClose[], shOut: number) {
  if (daily.length === 0) return { close: 0 }
  const close = daily[daily.length-1].price
  const lastDate = daily[daily.length-1].date
  const at = (daysAgo: number): number | null => {
    const target = minusDaysISO(lastDate, daysAgo); let best: number | null = null
    for (const p of daily) { if (p.date <= target) best = p.price; else break }
    return best
  }
  const prev1d = daily.length >= 2 ? daily[daily.length-2].price : null
  const prev1w = at(7), prev1m = at(30), prev3m = at(90), prev1y = at(365)
  const chg = (pc: number | null) => (pc && close) ? close / pc - 1 : null
  const mcap = shOut > 0 ? Math.round(close * shOut / 1e8) : 0
  return {
    close, prev1m: prev1m ?? undefined, mcap,
    chg1d: chg(prev1d), chg1w: chg(prev1w), chg3m: chg(prev3m), chg1y: chg(prev1y),
  }
}

// ── 銘柄ユニバース取得（Supabaseのお気に入り全件 ∪ フォールバック）──────
async function getUniverse(): Promise<string[]> {
  try {
    const { data, error } = await sb.from('favorites').select('code')
    if (error) throw error
    const set = new Set<string>(FALLBACK_WATCHLIST)
    for (const r of (data ?? []) as { code: string }[]) if (r.code) set.add(r.code)
    return Array.from(set)
  } catch (e) {
    console.warn('favorites取得失敗 → フォールバックリスト使用:', (e as Error).message)
    return [...FALLBACK_WATCHLIST]
  }
}

async function refreshOne(code: string, fromStr: string, toStr: string) {
  // 財務 → fin / shOut / fyEps
  let finRes: ReturnType<typeof buildFin> = null
  try {
    const fdata = await jq(`/fins/summary?code=${code}`)
    const stmts = (fdata as { data?: Record<string,string>[] }).data ?? []
    finRes = buildFin(stmts)
  } catch (e) { console.warn(`[fin] ${code}: ${(e as Error).message}`) }

  const shOut = finRes?.shOut ?? 0
  // 日次株価
  let daily: DailyClose[] = []
  try { daily = await fetchDaily(code, fromStr, toStr) } catch (e) { console.warn(`[daily] ${code}: ${(e as Error).message}`) }

  const price = buildPrice(daily, shOut)
  const fin = finRes?.fin ?? null
  const feps = fin?.feps ?? null
  const close = price.close ?? 0
  const fwdPER = (close && feps) ? close / feps : null
  const band = buildPerBand(daily, fin?.fyEps ?? null, fwdPER)

  return { code, price, fin, per_band: band }
}

async function main() {
  const universe = await getUniverse()
  console.log(`対象 ${universe.length} 銘柄を更新します`)
  const today = new Date()
  const from = new Date(today); from.setFullYear(from.getFullYear() - 1); from.setDate(from.getDate() - 21)
  const fromStr = ymd(from), toStr = ymd(today)
  const bizDate = iso(today)

  const rows: Record<string, unknown>[] = []
  let done = 0
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async code => {
      try { return await refreshOne(code, fromStr, toStr) }
      catch (e) { console.warn(`[skip] ${code}: ${(e as Error).message}`); return null }
    }))
    for (const r of results) {
      if (!r) continue
      rows.push({ code: r.code, price: r.price, fin: r.fin, per_band: r.per_band, biz_date: bizDate, updated_at: new Date().toISOString() })
    }
    done += batch.length
    if (done % 20 === 0 || done >= universe.length) console.log(`  ${Math.min(done, universe.length)}/${universe.length}`)
    await sleep(150)
  }

  // upsert（25件ずつ）
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25)
    const { error } = await sb.from('stock_snapshot').upsert(chunk, { onConflict: 'code' })
    if (error) { console.error('upsert失敗:', error.message); process.exit(1) }
  }
  await sb.from('snapshot_meta').upsert({ id: 1, biz_date: bizDate, count: rows.length, updated_at: new Date().toISOString() })

  console.log(`完了: ${rows.length}/${universe.length} 銘柄を保存（基準日 ${bizDate}）`)
}

main().catch(e => { console.error(e); process.exit(1) })
