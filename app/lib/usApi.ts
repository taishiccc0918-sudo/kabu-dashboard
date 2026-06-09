// 米国株データ取得ライブラリ（無料3層）
//
//   ・株価(日次1年)      … Stooq（無料・キー不要。例 aapl.us）
//   ・実績財務            … SEC EDGAR companyfacts（公式・無料・キー不要・要User-Agent）
//   ・予想EPS(コンセンサス) … FMP（任意。FMP_API_KEY があれば取得、無ければ null=「—」）
//   ・全銘柄マスター       … SEC company_tickers_exchange.json（無料・1回fetch）
//
// 重要(精度最優先): 取れない値は捏造しない。null / 0 を返し、UI側で「—」表示にする。
// 日本株の FinRecord / PriceRecord / FyEps と同じ形に揃え、buildPerBand / buildStockRow を再利用する。

import type { DailyClose, FyEps } from './perBand'
import type { FinRecord, PriceRecord } from './types'

// SEC は識別可能な User-Agent を必須とする（"name email" 形式推奨）。
const SEC_UA = (process.env.SEC_USER_AGENT ?? 'kabu-dashboard contact@example.com').trim()
const FMP_KEY = (process.env.FMP_API_KEY ?? '').trim()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function num(v: unknown): number { if (v == null || v === '') return 0; const x = Number(v); return isNaN(x) ? 0 : x }

// ── ティッカー正規化 ─────────────────────────────────────────────
// 正規形(=DB主キー)は SEC 表記（ドットはハイフン: BRK.B → BRK-B）。
export function toSec(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\./g, '-')
}
// Stooq は小文字 + .us、ドット/ハイフンはハイフン（brk-b.us）。
export function toStooq(ticker: string): string {
  return toSec(ticker).toLowerCase() + '.us'
}
// FMP は SEC とほぼ同じ（ハイフン）。
export function toFmp(ticker: string): string {
  return toSec(ticker)
}

// ── 日次株価（調整後終値）→ DailyClose[] ────────────────────────
// 主: Yahoo Finance chart API（無料・JSON・キー不要・安定）。フォールバック: Stooq。
// Stooq は近年JSのbot検証を挟むことがあり単純fetchで失敗しうるため主従を入れ替えている。
export async function fetchUsDaily(ticker: string, fromISO: string, toISO: string): Promise<DailyClose[]> {
  try {
    const y = await fetchYahooDaily(ticker, fromISO, toISO)
    if (y.length > 0) return y
  } catch { /* fall through to stooq */ }
  try {
    return await fetchStooqDaily(ticker, fromISO, toISO)
  } catch { return [] }
}

// Yahoo Finance chart API。adjclose 優先・無ければ close。
export async function fetchYahooDaily(ticker: string, fromISO: string, toISO: string): Promise<DailyClose[]> {
  const sym = toSec(ticker)  // Yahoo も BRK-B 表記
  const p1 = Math.floor(Date.parse(fromISO + 'T00:00:00Z') / 1000)
  const p2 = Math.floor(Date.parse(toISO + 'T23:59:59Z') / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 kabu-dashboard' } })
  if (!res.ok) throw new Error(`yahoo ${res.status}`)
  const json = await res.json() as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { adjclose?: Array<{ adjclose?: (number | null)[] }>; quote?: Array<{ close?: (number | null)[] }> } }> }
  }
  const r = json.chart?.result?.[0]
  const ts = r?.timestamp ?? []
  const adj = r?.indicators?.adjclose?.[0]?.adjclose
  const cls = r?.indicators?.quote?.[0]?.close
  const out: DailyClose[] = []
  for (let i = 0; i < ts.length; i++) {
    const price = num(adj?.[i] ?? cls?.[i])
    if (!price || price <= 0) continue
    const d = new Date(ts[i] * 1000)
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    out.push({ date, price })
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return out
}

// ── Stooq（フォールバック）: 日次株価 CSV: Date,Open,High,Low,Close,Volume ──
export async function fetchStooqDaily(ticker: string, fromISO: string, toISO: string): Promise<DailyClose[]> {
  const s = toStooq(ticker)
  const d1 = fromISO.replace(/-/g, ''), d2 = toISO.replace(/-/g, '')
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&d1=${d1}&d2=${d2}&i=d`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 kabu-dashboard' } })
  if (!res.ok) throw new Error(`stooq ${res.status}`)
  const text = await res.text()
  // 取得失敗時 Stooq は "No data" 等のCSV以外を返す
  if (!text || /no data/i.test(text) || !text.includes(',')) return []
  const lines = text.trim().split('\n')
  const out: DailyClose[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',')
    const date = cols[0]
    const price = num(cols[4])
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && price > 0) out.push({ date, price })
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return out
}

// ── SEC EDGAR companyfacts ───────────────────────────────────────
type Fact = { end: string; start?: string; val: number; fy?: number; fp?: string; form?: string; filed?: string; frame?: string }
type ConceptUnits = Record<string, Fact[]>
type CompanyFacts = { cik?: number; entityName?: string; facts?: Record<string, Record<string, { units?: ConceptUnits }>> }

export async function fetchCompanyFacts(cik: string): Promise<CompanyFacts | null> {
  const padded = String(cik).replace(/\D/g, '').padStart(10, '0')
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`edgar ${res.status}`)
  return res.json() as Promise<CompanyFacts>
}

// 年次(10-K/20-F/40-F・通期)の事実だけを抽出。最初に見つかったタグ候補を採用。
function annualFacts(cf: CompanyFacts, candidates: string[], unit: string, opts: { instant?: boolean } = {}): Fact[] {
  const facts = cf.facts ?? {}
  for (const ns of ['us-gaap', 'ifrs-full', 'dei']) {
    const nsObj = facts[ns]; if (!nsObj) continue
    for (const concept of candidates) {
      const arr = nsObj[concept]?.units?.[unit]
      if (!arr || arr.length === 0) continue
      const annual = arr.filter(f => {
        if (!f.end || typeof f.val !== 'number') return false
        const form = (f.form ?? '')
        const isAnnualForm = form.startsWith('10-K') || form.startsWith('20-F') || form.startsWith('40-F')
        if (!isAnnualForm) return false
        if (opts.instant) return true
        // フロー指標は通期(約1年)のみ採用（四半期/YTD部分期を除外）
        if (f.fp && f.fp !== 'FY') return false
        if (f.start) {
          const days = (Date.parse(f.end) - Date.parse(f.start)) / 86400000
          if (!(days >= 340 && days <= 380)) return false
        }
        return true
      })
      if (annual.length > 0) {
        annual.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : (a.filed ?? '') < (b.filed ?? '') ? -1 : 1))
        return annual
      }
    }
  }
  return []
}

function latestVal(cf: CompanyFacts, candidates: string[], unit: string, opts: { instant?: boolean } = {}): number {
  const arr = annualFacts(cf, candidates, unit, opts)
  return arr.length ? arr[arr.length - 1].val : 0
}

// 軽量: 発行済株式数だけを companyconcept から取得（companyfactsは重いので時価総額一括用に分離）。
export async function fetchSharesOutstanding(cik: string): Promise<number> {
  const padded = String(cik).replace(/\D/g, '').padStart(10, '0')
  const concepts: [string, string][] = [
    ['dei', 'EntityCommonStockSharesOutstanding'],
    ['us-gaap', 'CommonStockSharesOutstanding'],
    ['us-gaap', 'CommonStockSharesIssued'],
    // フォールバック: 加重平均株式数（多くの企業が開示）。最新の値を使う。
    ['us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
    ['us-gaap', 'WeightedAverageNumberOfSharesOutstandingBasic'],
    ['dei', 'EntityCommonStockSharesOutstanding'],
  ]
  for (const [ns, concept] of concepts) {
    try {
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/${ns}/${concept}.json`
      const res = await fetch(url, { headers: { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' } })
      if (!res.ok) continue
      const j = await res.json() as { units?: Record<string, { end?: string; val?: number }[]> }
      const arr = j.units?.shares ?? []
      let best = 0, bestEnd = ''
      for (const e of arr) { if (typeof e.val === 'number' && (e.end ?? '') >= bestEnd) { bestEnd = e.end ?? ''; best = e.val } }
      if (best > 0) return best
    } catch { /* try next */ }
  }
  return 0
}

// 軽量: 最新株価だけを Yahoo chart の meta から取得（range=1d）。
export async function fetchYahooPrice(ticker: string): Promise<number> {
  const sym = toSec(ticker)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 kabu-dashboard' } })
    if (!res.ok) return 0
    const j = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } }
    return num(j.chart?.result?.[0]?.meta?.regularMarketPrice)
  } catch { return 0 }
}

// SEC submissions から業種（SIC説明）を取得＝米国版の簡易「事業内容」。
// 例: 'Semiconductors & Related Devices' / 'Electronic Computers'。
export async function fetchSecSic(cik: string): Promise<{ sic: string; sicLabel: string } | null> {
  const padded = String(cik).replace(/\D/g, '').padStart(10, '0')
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' } })
    if (!res.ok) return null
    const j = await res.json() as { sic?: string; sicDescription?: string }
    const sicLabel = (j.sicDescription ?? '').trim()
    if (!sicLabel) return null
    return { sic: String(j.sic ?? ''), sicLabel }
  } catch { return null }
}

// FinRecord 形に組み立てる（日本株と同じ構造・予想系はnull）。fyEps はバンドのレール用。
export function buildFinUS(cf: CompanyFacts): { fin: FinRecord; shOut: number } {
  const eps    = latestVal(cf, ['EarningsPerShareDiluted', 'EarningsPerShareBasic', 'IncomeLossFromContinuingOperationsPerDilutedShare'], 'USD/shares')
  const sales  = latestVal(cf, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'], 'USD')
  const op     = latestVal(cf, ['OperatingIncomeLoss'], 'USD')
  const np     = latestVal(cf, ['NetIncomeLoss', 'ProfitLoss'], 'USD')
  const equity = latestVal(cf, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'Equity'], 'USD', { instant: true })
  const assets = latestVal(cf, ['Assets'], 'USD', { instant: true })
  const div    = latestVal(cf, ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'], 'USD/shares')
  // 発行済株式数: dei 優先 → us-gaap フォールバック（instant・shares単位）
  let shOut = latestVal(cf, ['EntityCommonStockSharesOutstanding'], 'shares', { instant: true })
  if (!shOut) shOut = latestVal(cf, ['CommonStockSharesOutstanding', 'CommonStockSharesIssued'], 'shares', { instant: true })

  // fyEps: 年次の希薄化後EPS実績（直近5期）。開示日(filed)を階段関数の境界に使う。
  // annualFacts は (end昇順, filed昇順) でソート済み。同一期末は「最初に開示された(=最古filed)」を採用する。
  // 後年の10-Kが比較年として再掲した値(filed=直近)で上書きすると、PERバンドの階段関数の日付が
  // 全部直近に潰れてしまうため。市場が最初にその実績を知った日を境界にするのが正しい。
  const epsAnnual = annualFacts(cf, ['EarningsPerShareDiluted', 'EarningsPerShareBasic'], 'USD/shares')
  const byEnd = new Map<string, { d: string; eps: number }>()
  for (const f of epsAnnual) {
    if (typeof f.val !== 'number') continue
    if (!byEnd.has(f.end)) byEnd.set(f.end, { d: (f.filed ?? f.end), eps: f.val })
  }
  const fyEps: FyEps[] = Array.from(byEnd.values())
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .slice(-5)

  // 最新開示日（discDate表示用）
  const allArr = annualFacts(cf, ['NetIncomeLoss', 'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'Assets'], 'USD', { instant: false })
    .concat(annualFacts(cf, ['Assets'], 'USD', { instant: true }))
  const discDate = allArr.length ? (allArr[allArr.length - 1].filed ?? allArr[allArr.length - 1].end) : ''

  const fin: FinRecord = {
    sales, op, odp: 0, np, eps,
    feps: null, nyEPS: null,                 // 予想EPSは後段(FMP)で充当。無ければnull=「—」
    bps: shOut ? equity / shOut : 0,
    equity, assets, divAnn: div, fdiv: div, shOut,
    discDate, perType: 'FY',
    roe: (equity && np) ? np / equity : null,
    eqRat: assets ? equity / assets : 0,
    opMgn: (sales && op) ? op / sales : null,
    salesGr: 0,                              // 米国は将来ガイダンス無し → 来期売上成長は「—」
    nySalesGr: null,
    fsales: 0, fop: 0, nySales: 0, nyOP: 0,
    feps1m: null,
    fyEps,
  }
  return { fin, shOut }
}

// 日次系列 → PriceRecord（mcap は USD百万）
export function buildPriceUS(daily: DailyClose[], shOut: number): PriceRecord {
  if (daily.length === 0) return { close: 0 }
  const close = daily[daily.length - 1].price
  const lastDate = daily[daily.length - 1].date
  const minus = (days: number): string => {
    const [y, m, d] = lastDate.split('-').map(Number)
    const t = Date.UTC(y, m - 1, d) - days * 86400000
    const dt = new Date(t)
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
  }
  const at = (days: number): number | null => {
    const target = minus(days); let best: number | null = null
    for (const p of daily) { if (p.date <= target) best = p.price; else break }
    return best
  }
  const prev1d = daily.length >= 2 ? daily[daily.length - 2].price : null
  const prev1w = at(7), prev1m = at(30), prev3m = at(90), prev1y = at(365)
  const chg = (pc: number | null) => (pc && close) ? close / pc - 1 : undefined
  const mcap = shOut > 0 ? Math.round(close * shOut / 1e6) : 0  // USD百万
  return {
    close, prev1m: prev1m ?? undefined, mcap,
    chg1d: chg(prev1d), chg1w: chg(prev1w), chg3m: chg(prev3m), chg1y: chg(prev1y),
  }
}

// ── FMP: 予想EPS（コンセンサス）。任意。失敗時は静かに null を返す。 ──
// 戻り値: { feps(今期予想EPS) | null, nyEPS(来期予想EPS) | null }
export async function fetchFmpForwardEps(ticker: string, todayISO: string): Promise<{ feps: number | null; nyEPS: number | null }> {
  if (!FMP_KEY) return { feps: null, nyEPS: null }
  try {
    const sym = toFmp(ticker)
    const url = `https://financialmodelingprep.com/api/v3/analyst-estimates/${encodeURIComponent(sym)}?period=annual&limit=10&apikey=${FMP_KEY}`
    const res = await fetch(url)
    if (!res.ok) return { feps: null, nyEPS: null }
    const arr = await res.json() as Array<{ date?: string; estimatedEpsAvg?: number }>
    if (!Array.isArray(arr) || arr.length === 0) return { feps: null, nyEPS: null }
    // 会計年度末日(date)が今日以降の見通しを古い順に。先頭=今期、次=来期。
    const future = arr
      .filter(e => e.date && e.date >= todayISO && typeof e.estimatedEpsAvg === 'number')
      .sort((a, b) => (a.date! < b.date! ? -1 : 1))
    const feps = future[0]?.estimatedEpsAvg ?? null
    const nyEPS = future[1]?.estimatedEpsAvg ?? null
    return { feps: (feps && feps !== 0) ? feps : null, nyEPS: (nyEPS && nyEPS !== 0) ? nyEPS : null }
  } catch {
    return { feps: null, nyEPS: null }
  }
}

// ── マスター: 全米上場一覧（ticker / name / exchange / cik）─────────
// SEC company_tickers_exchange.json: { fields:[...], data:[[cik, name, ticker, exchange], ...] }
export type UsMasterEntry = { ticker: string; name: string; exchange: string; cik: string }
export async function fetchUsMaster(): Promise<UsMasterEntry[]> {
  const url = 'https://www.sec.gov/files/company_tickers_exchange.json'
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA } })
  if (!res.ok) throw new Error(`sec master ${res.status}`)
  const json = await res.json() as { fields: string[]; data: unknown[][] }
  const fi = json.fields.indexOf('cik')
  const ni = json.fields.indexOf('name')
  const ti = json.fields.indexOf('ticker')
  const xi = json.fields.indexOf('exchange')
  const out: UsMasterEntry[] = []
  const seen = new Set<string>()
  for (const row of json.data) {
    const ticker = toSec(String(row[ti] ?? ''))
    const name = String(row[ni] ?? '')
    const exchange = String(row[xi] ?? '')
    const cik = String(row[fi] ?? '').replace(/\D/g, '').padStart(10, '0')
    if (!ticker || !name || seen.has(ticker)) continue
    seen.add(ticker)
    out.push({ ticker, name, exchange, cik })
  }
  return out
}

export { sleep as usSleep }
