/**
 * 企業ロゴ収集エンジン: Wikidata から東証上場企業の「公式ロゴ画像(P154)」と
 * 「公式サイト(P856)」を取得し、code→ロゴURL を Supabase `company_logo` に upsert。
 * GitHub Actions（月次cron＋手動）から実行。EDINETと違いAPIキー不要。
 *
 * ロゴURLの決め方（捏造ゼロ＝一次情報のみ）:
 *   1) Wikidataに公式ロゴ画像(P154)があれば Wikimedia Commons の縮小URLを採用（最も確実）
 *   2) なければ公式サイト(P856)のドメインから Clearbit ロゴ（企業公開アセット）
 *   3) どちらも無ければ未登録（フロントは色イニシャルチップにフォールバック）
 *
 * 必要な環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（既存シークレットを流用）
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('必須の環境変数が未設定です（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const UA = 'kabu-dashboard/1.0 (logo master; contact: enpivot)'
const WDQS = 'https://query.wikidata.org/sparql'

// 東証(Q217475)に上場し ticker(P249) を持つ企業の ticker / ロゴ / 公式サイト
const QUERY = `
SELECT ?ticker ?logo ?site WHERE {
  ?company p:P414 ?st .
  ?st ps:P414 wd:Q217475 .
  ?st pq:P249 ?ticker .
  OPTIONAL { ?company wdt:P154 ?logo . }
  OPTIONAL { ?company wdt:P856 ?site . }
}`

// 証券コードへ正規化（4桁数字 or 新形式の4字英数字。例 7203 / 290A）
function normCode(raw: string): string | null {
  const c = (raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (/^[0-9]{4}$/.test(c)) return c
  if (/^[0-9]{3}[0-9A-Z]$/.test(c)) return c
  // 末尾に取引所サフィックス等が付く場合は先頭4字を試す
  const head = c.slice(0, 4)
  if (/^[0-9]{3}[0-9A-Z]$/.test(head)) return head
  return null
}

// Wikidata P154 の値（Special:FilePath URL）を 128px サムネに
function commonsThumb(url: string): string {
  try {
    const u = new URL(url)
    if (!u.searchParams.has('width')) u.searchParams.set('width', '128')
    return u.toString()
  } catch { return url }
}

function clearbitFromSite(site: string): string | null {
  try {
    const host = new URL(site).hostname.replace(/^www\./, '')
    if (!host || !host.includes('.')) return null
    return `https://logo.clearbit.com/${host}?size=128`
  } catch { return null }
}

async function main() {
  console.log('Wikidata から東証上場企業のロゴ/公式サイトを取得中…')
  const res = await fetch(`${WDQS}?query=${encodeURIComponent(QUERY)}`, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
  })
  if (!res.ok) { console.error('Wikidata SPARQL 失敗', res.status); process.exit(1) }
  const json = await res.json() as { results: { bindings: Array<Record<string, { value: string }>> } }
  const rows = json.results.bindings

  // code ごとに最良のロゴを選ぶ（P154優先、なければClearbit）
  const best = new Map<string, { logo_url: string; source: string }>()
  for (const b of rows) {
    const code = normCode(b.ticker?.value ?? '')
    if (!code) continue
    const cur = best.get(code)
    if (b.logo?.value) {
      // P154 が最優先（既に wikidata 採用済みなら据え置き）
      if (!cur || cur.source !== 'wikidata') best.set(code, { logo_url: commonsThumb(b.logo.value), source: 'wikidata' })
    } else if (b.site?.value && !cur) {
      const cb = clearbitFromSite(b.site.value)
      if (cb) best.set(code, { logo_url: cb, source: 'clearbit' })
    }
  }

  const records = [...best.entries()].map(([code, v]) => ({ code, logo_url: v.logo_url, source: v.source, updated_at: new Date().toISOString() }))
  const wikidataN = records.filter(r => r.source === 'wikidata').length
  console.log(`収集: ${records.length}社（公式ロゴ ${wikidataN} / Clearbit ${records.length - wikidataN}）`)

  // 500件ずつ upsert
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500)
    const { error } = await sb.from('company_logo').upsert(chunk, { onConflict: 'code' })
    if (error) { console.error('upsert失敗', error.message); process.exit(1) }
    console.log(`  upsert ${Math.min(i + 500, records.length)}/${records.length}`)
  }
  console.log('完了')
}

main().catch(e => { console.error(e); process.exit(1) })
