/**
 * 米国株 時価総額の広域取得（軽量版）: us_master 全銘柄について
 * 発行済株式数(EDGAR companyconcept・軽量) × 最新株価(Yahoo) → mcap を us_master に保存。
 * 深掘りスナップショット(refresh-us)とは別に、より多くの銘柄(数千)に時価総額を付けるための専用パス。
 * GitHub Actions（週次cron＋手動）から `npx tsx scripts/refresh-us-mcap.ts` で実行。
 *
 * 必要な環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SEC_USER_AGENT
 */
import { createClient } from '@supabase/supabase-js'
import { fetchSharesOutstanding, fetchYahooPrice, usSleep } from '../app/lib/usApi'

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

const CONCURRENCY = 4   // EDGAR ≤10req/s を守るため控えめ
const MAX = Number(process.env.US_MCAP_MAX ?? '0') || 0  // 0=全件

async function getMaster(): Promise<{ ticker: string; cik: string }[]> {
  const out: { ticker: string; cik: string }[] = []
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from('us_master').select('ticker, cik').range(p * 1000, p * 1000 + 999)
    if (error) { console.warn('us_master読込失敗:', error.message); break }
    const chunk = (data ?? []) as { ticker: string; cik: string }[]
    for (const r of chunk) if (r.ticker && r.cik) out.push({ ticker: r.ticker, cik: r.cik })
    if (chunk.length < 1000) break
  }
  return out
}

async function main() {
  let universe = await getMaster()
  if (MAX > 0) universe = universe.slice(0, MAX)
  console.log(`時価総額(軽量)対象: ${universe.length} 銘柄`)

  const updates: Record<string, unknown>[] = []
  let done = 0, ok = 0
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async ({ ticker, cik }) => {
      try {
        const [shares, price] = await Promise.all([fetchSharesOutstanding(cik), fetchYahooPrice(ticker)])
        if (shares > 0 && price > 0) return { ticker, mcap: Math.round(price * shares / 1e6) } // USD百万
      } catch { /* skip */ }
      return null
    }))
    for (const r of results) {
      if (r && r.mcap > 0) { updates.push({ ticker: r.ticker, mcap: r.mcap, updated_at: new Date().toISOString() }); ok++ }
    }
    done += batch.length
    if (done % 200 === 0 || done >= universe.length) console.log(`  ${Math.min(done, universe.length)}/${universe.length}（mcap取得 ${ok}）`)
    await usSleep(200) // EDGAR配慮（4並列 × 200ms ≈ 8req/s以下）
  }

  for (let i = 0; i < updates.length; i += 200) {
    const { error } = await sb.from('us_master').upsert(updates.slice(i, i + 200), { onConflict: 'ticker' })
    if (error) { console.error('upsert失敗:', error.message); process.exit(1) }
  }
  console.log(`完了: ${ok}/${universe.length} 銘柄に時価総額を保存`)
}

main().catch(e => { console.error(e); process.exit(1) })
