/**
 * 米国株マスター更新: SEC の全上場一覧（ticker/name/exchange/cik）を us_master に保存。
 * GitHub Actions（週次cron＋手動）から `npx tsx scripts/refresh-us-master.ts` で実行する。
 *
 * 必要な環境変数:
 *   SUPABASE_URL               … 例 https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  … service_role キー（RLSバイパス）
 *   SEC_USER_AGENT             … "name email" 形式（SEC必須）。未設定でも既定値で動くが登録推奨。
 *
 * 無料（SECのみ・1回fetch）。深掘り指標(mcap/sic)は refresh-us.ts 側で上位銘柄に付与する。
 */
import { createClient } from '@supabase/supabase-js'
import { fetchUsMaster } from '../app/lib/usApi'

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

async function main() {
  console.log('SEC company_tickers_exchange.json を取得中...')
  const entries = await fetchUsMaster()
  console.log(`取得 ${entries.length} 銘柄。us_master に upsert します`)
  let done = 0
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500).map(e => ({
      ticker: e.ticker, name: e.name, exchange: e.exchange, cik: e.cik, updated_at: new Date().toISOString(),
    }))
    const { error } = await sb.from('us_master').upsert(chunk, { onConflict: 'ticker' })
    if (error) { console.error('upsert失敗:', error.message); process.exit(1) }
    done += chunk.length
    if (done % 2000 === 0 || done >= entries.length) console.log(`  ${Math.min(done, entries.length)}/${entries.length}`)
  }
  console.log(`完了: ${entries.length} 銘柄をマスター保存`)
}

main().catch(e => { console.error(e); process.exit(1) })
