/**
 * 米国株 深掘りスナップショット: 上位銘柄 ∪ お気に入り(US:)について
 * 実績財務(EDGAR)＋株価(Stooq)＋予想EPS(FMP任意)を取得→指標/PERバンドを計算→us_stock_snapshot に保存。
 * GitHub Actions（平日cron＋手動）から `npx tsx scripts/refresh-us.ts` で実行する。
 *
 * 必要な環境変数:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  … Supabase（RLSバイパス書込）
 *   SEC_USER_AGENT                            … "name email"（SEC必須・推奨）
 *   FMP_API_KEY                               … 任意。あれば予想EPS(PER今期/PEG)を充当、無ければ「—」
 *
 * 設計: 日本株 refresh.ts と同じく buildPerBand を共有。財務組み立ては usApi.buildFinUS。
 * 精度最優先: 取れない値は捏造せず null/0（UIで「—」）。
 */
import { createClient } from '@supabase/supabase-js'
import { buildPerBand } from '../app/lib/perBand'
import {
  fetchCompanyFacts, buildFinUS, fetchUsDaily, buildPriceUS, fetchFmpForwardEps, usSleep, fetchSecSic,
} from '../app/lib/usApi'
import { SP500, NDX100 } from '../app/lib/usIndices'

function normalizeUrl(raw: string): string {
  let u = (raw ?? '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/\s+/g, '').replace(/\/+$/, '')
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u
  return u
}
const SUPABASE_URL = normalizeUrl(process.env.SUPABASE_URL ?? '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('必須の環境変数が未設定です（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// 深掘り対象の主要銘柄（時価総額上位中心。セクター横断。随時拡張可）。
const TOP_US = [
  'AAPL','MSFT','GOOGL','GOOG','AMZN','NVDA','META','TSLA','BRK-B','AVGO',
  'LLY','JPM','V','UNH','XOM','MA','JNJ','PG','HD','COST',
  'ORCL','MRK','ABBV','CVX','KO','PEP','ADBE','BAC','CRM','AMD',
  'NFLX','TMO','ACN','LIN','MCD','CSCO','ABT','WMT','DHR','INTC',
  'WFC','TXN','QCOM','PM','DIS','VZ','INTU','CAT','IBM','AMGN',
  'NOW','UNP','GE','SPGI','HON','LOW','ISRG','GS','BKNG','AXP',
  'PFE','SYK','BLK','ELV','T','VRTX','C','MS','GILD','MDT',
  'TJX','REGN','ADP','LRCX','CB','MU','PLD','SBUX','BMY','SCHW',
  'MMC','DE','BSX','ADI','ETN','KLAC','PANW','SO','CI','ZTS',
  'DUK','FI','MO','BX','SNPS','APH','CDNS','ICE','SHW','PGR',
  'CMG','EQIX','PYPL','TT','CME','PNC','USB','AON','ITW','CL',
  'MSI','GD','MCK','EOG','NKE','WM','EMR','MMM','FCX','CSX',
  'PH','MAR','APD','ORLY','NOC','PCAR','HCA','COF','ROP','TGT',
  'MPC','NXPI','AJG','CARR','SLB','FDX','PSX','ABNB','OXY','TFC',
  'DELL','CRWD','UBER','PLTR','SMCI','COIN','SQ','SHOP','MRNA','F',
  'GM','DAL','UAL','RIVN','LCID','SOFI','HOOD','RBLX','SNAP','PINS',
]

type UsFin = ReturnType<typeof buildFinUS>['fin']

async function getUniverse(): Promise<{ ticker: string; cik: string }[]> {
  // us_master から ticker→cik を引く
  const cikByTicker = new Map<string, string>()
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from('us_master').select('ticker, cik').range(p * 1000, p * 1000 + 999)
    if (error) { console.warn('us_master読込失敗:', error.message); break }
    const chunk = (data ?? []) as { ticker: string; cik: string }[]
    for (const r of chunk) if (r.ticker && r.cik) cikByTicker.set(r.ticker, r.cik)
    if (chunk.length < 1000) break
  }
  // 深掘り対象 = TOP_US ∪ S&P500 ∪ NASDAQ100 ∪ お気に入り（約550社・全て時価総額＋全指標が付く）
  const set = new Set<string>([...TOP_US, ...SP500, ...NDX100])
  try {
    const { data } = await sb.from('favorites').select('code').like('code', 'US:%')
    for (const r of (data ?? []) as { code: string }[]) {
      const t = (r.code || '').replace(/^US:/, '').toUpperCase().replace(/\./g, '-')
      if (t) set.add(t)
    }
  } catch (e) { console.warn('US favorites取得失敗:', (e as Error).message) }

  const out: { ticker: string; cik: string }[] = []
  for (const ticker of set) {
    const cik = cikByTicker.get(ticker)
    if (cik) out.push({ ticker, cik })
    else console.warn(`[no-cik] ${ticker} は us_master に無い（マスター未更新の可能性）`)
  }
  return out
}

async function refreshOne(ticker: string, cik: string, fromISO: string, toISO: string, useFmp: boolean) {
  let fin: UsFin | null = null
  let shOut = 0
  try {
    const cf = await fetchCompanyFacts(cik)
    if (cf) { const r = buildFinUS(cf); fin = r.fin; shOut = r.shOut }
  } catch (e) { console.warn(`[edgar] ${ticker}: ${(e as Error).message}`) }

  let daily: Awaited<ReturnType<typeof fetchUsDaily>> = []
  try { daily = await fetchUsDaily(ticker, fromISO, toISO) } catch (e) { console.warn(`[price] ${ticker}: ${(e as Error).message}`) }

  const price = buildPriceUS(daily, shOut)

  // 予想EPS（任意・巡回対象のみ）
  if (fin && useFmp) {
    try {
      const { feps, nyEPS } = await fetchFmpForwardEps(ticker, toISO)
      if (feps != null) fin.feps = feps
      if (nyEPS != null) fin.nyEPS = nyEPS
    } catch { /* 失敗は静かに無視（feps=null＝「—」） */ }
  }

  const close = price.close ?? 0
  const feps = fin?.feps ?? null
  const fwdPER = (close && feps) ? close / feps : null
  const band = buildPerBand(daily, fin?.fyEps ?? null, fwdPER)

  // マスターに mcap を反映（時価総額の表示に使用）
  const mcap = price.mcap ?? 0
  // 業種(SIC)＝簡易「事業内容」
  let sicLabel = '', sic = ''
  try { const s = await fetchSecSic(cik); if (s) { sicLabel = s.sicLabel; sic = s.sic } } catch { /* noop */ }
  return { ticker, cik, price, fin, per_band: band, mcap, sic, sicLabel }
}

async function main() {
  const universe = await getUniverse()
  console.log(`対象 ${universe.length} 銘柄（米国株 深掘り）を更新します`)
  const today = new Date()
  const toISO = today.toISOString().slice(0, 10)
  const from = new Date(today); from.setFullYear(from.getFullYear() - 1); from.setDate(from.getDate() - 21)
  const fromISO = from.toISOString().slice(0, 10)
  const bizDate = toISO

  // FMP 無料枠（~250/日）対策: 日付で巡回し、1回あたり最大 FMP_PER_RUN 銘柄だけ予想EPSを取りに行く。
  const hasFmp = !!(process.env.FMP_API_KEY ?? '').trim()
  const FMP_PER_RUN = 200
  const offset = hasFmp ? (today.getUTCDate() * FMP_PER_RUN) % Math.max(1, universe.length) : 0
  const fmpSet = new Set<string>()
  if (hasFmp) for (let i = 0; i < Math.min(FMP_PER_RUN, universe.length); i++) fmpSet.add(universe[(offset + i) % universe.length].ticker)
  console.log(hasFmp ? `FMP予想EPS: 今回 ${fmpSet.size} 銘柄を巡回取得` : 'FMP_API_KEY 未設定 → 予想EPS系は「—」（実績ベースで表示）')

  const CONCURRENCY = 5
  const rows: Record<string, unknown>[] = []
  const masterUpd: Record<string, unknown>[] = []
  let done = 0
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async ({ ticker, cik }) => {
      try { return await refreshOne(ticker, cik, fromISO, toISO, fmpSet.has(ticker)) }
      catch (e) { console.warn(`[skip] ${ticker}: ${(e as Error).message}`); return null }
    }))
    for (const r of results) {
      if (!r) continue
      rows.push({ ticker: r.ticker, price: r.price, fin: r.fin, per_band: r.per_band, biz_date: bizDate, updated_at: new Date().toISOString() })
      if (r.mcap > 0 || r.sicLabel) {
        const m: Record<string, unknown> = { ticker: r.ticker, updated_at: new Date().toISOString() }
        if (r.mcap > 0) m.mcap = r.mcap
        if (r.sicLabel) { m.sic = r.sic; m.sic_label = r.sicLabel }
        masterUpd.push(m)
      }
    }
    done += batch.length
    if (done % 20 === 0 || done >= universe.length) console.log(`  ${Math.min(done, universe.length)}/${universe.length}`)
    await usSleep(350) // EDGAR ≤10req/s（companyfacts＋submissionsで1社2回）＆ 配慮
  }

  for (let i = 0; i < rows.length; i += 25) {
    const { error } = await sb.from('us_stock_snapshot').upsert(rows.slice(i, i + 25), { onConflict: 'ticker' })
    if (error) { console.error('upsert失敗:', error.message); process.exit(1) }
  }
  // マスターの mcap を更新（深掘り銘柄のみ。onConflict で既存行を更新）
  for (let i = 0; i < masterUpd.length; i += 100) {
    const { error } = await sb.from('us_master').upsert(masterUpd.slice(i, i + 100), { onConflict: 'ticker' })
    if (error) console.warn('us_master mcap更新失敗:', error.message)
  }
  await sb.from('us_snapshot_meta').upsert({ id: 1, biz_date: bizDate, count: rows.length, updated_at: new Date().toISOString() })

  console.log(`完了: ${rows.length}/${universe.length} 銘柄を保存（基準日 ${bizDate}）`)
}

main().catch(e => { console.error(e); process.exit(1) })
