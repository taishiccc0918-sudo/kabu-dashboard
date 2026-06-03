/**
 * 企業ロゴ収集エンジン: Wikidata から「ticker(P249)を持つ全企業」の公式ロゴ(P154)/公式サイト(P856)を
 * 広く取得し、JPX上場コード一覧と突き合わせて「実在する日本の上場コード」だけ採用する。
 * （香港株など他国の4桁tickerとの衝突＝誤ロゴを排除）。GitHub Actions（月次cron＋手動）から実行。APIキー不要。
 *
 * ロゴURLの決め方（捏造ゼロ＝一次情報のみ・誤マッチ防止）:
 *   - 候補のランク: 日本の取引所に上場(P17=Q17) > その他、 公式ロゴ(P154) > 公式サイト→Clearbit
 *   - JPX一覧に無いコードは捨てる（＝必ず実在の日本上場銘柄に限定）
 *
 * 必要な環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（既存シークレットを流用）
 */
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('必須の環境変数が未設定です（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const UA = 'kabu-dashboard/1.0 (logo master; contact: enpivot)'
const WDQS = 'https://query.wikidata.org/sparql'
const JPX_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls'

// 全企業の (ticker, 取引所の所在国, ロゴ, 公式サイト)。4字英数tickerに限定（JPコード形式）。
const QUERY = `
SELECT ?ticker ?country ?logo ?site WHERE {
  ?c p:P414 ?st .
  ?st pq:P249 ?ticker .
  FILTER(REGEX(STR(?ticker), "^[0-9A-Z]{4}$"))
  ?st ps:P414 ?exch .
  OPTIONAL { ?exch wdt:P17 ?country . }
  OPTIONAL { ?c wdt:P154 ?logo . }
  OPTIONAL { ?c wdt:P856 ?site . }
}`

function normCode(raw: string): string | null {
  const c = (raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (/^[0-9]{4}$/.test(c) || /^[0-9]{3}[0-9A-Z]$/.test(c)) return c
  return null
}
function commonsThumb(url: string): string {
  try { const u = new URL(url); if (!u.searchParams.has('width')) u.searchParams.set('width', '128'); return u.toString() } catch { return url }
}
function clearbitFromSite(site: string): string | null {
  try { const host = new URL(site).hostname.replace(/^www\./, ''); return host.includes('.') ? `https://logo.clearbit.com/${host}?size=128` : null } catch { return null }
}

// JPX上場一覧の「コード集合」（これに含まれるコードだけ採用＝実在の日本上場銘柄に限定）
async function getJpxCodes(): Promise<Set<string>> {
  const res = await fetch(JPX_URL, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`JPX ${res.status}`)
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })
  const set = new Set<string>()
  for (const row of rows) {
    if (!row || row.length < 2) continue
    let code = String(row[1] ?? '').trim().toUpperCase()
    if (!/^[0-9A-Z]{3,5}$/.test(code)) continue
    if (code.length === 5 && code.endsWith('0')) code = code.slice(0, 4)
    if (/^[0-9A-Z]{4}$/.test(code)) set.add(code)
  }
  return set
}

type Cand = { logo_url: string; source: string; jp: boolean }

async function main() {
  console.log('JPX上場一覧を取得中…')
  const jpx = await getJpxCodes()
  console.log(`JPX上場コード: ${jpx.size}件`)

  console.log('Wikidata から ticker付き企業のロゴ/公式サイトを取得中…')
  const res = await fetch(`${WDQS}?query=${encodeURIComponent(QUERY)}`, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA } })
  if (!res.ok) { console.error('Wikidata SPARQL 失敗', res.status); process.exit(1) }
  const json = await res.json() as { results: { bindings: Array<Record<string, { value: string }>> } }
  const rows = json.results.bindings
  console.log(`Wikidata 行数: ${rows.length}`)

  // code ごとに最良候補を選ぶ。優先: 日本上場 > その他、公式ロゴ > Clearbit
  const best = new Map<string, Cand>()
  const rank = (c: Cand) => (c.jp ? 2 : 0) + (c.source === 'wikidata' ? 1 : 0)
  for (const b of rows) {
    const code = normCode(b.ticker?.value ?? '')
    if (!code || !jpx.has(code)) continue                 // 実在の日本上場コードのみ
    const jp = (b.country?.value ?? '').endsWith('Q17')    // 取引所の所在国＝日本
    let cand: Cand | null = null
    if (b.logo?.value) cand = { logo_url: commonsThumb(b.logo.value), source: 'wikidata', jp }
    else if (b.site?.value) { const cb = clearbitFromSite(b.site.value); if (cb) cand = { logo_url: cb, source: 'clearbit', jp } }
    if (!cand) continue
    const cur = best.get(code)
    if (!cur || rank(cand) > rank(cur)) best.set(code, cand)
  }

  const records = [...best.entries()].map(([code, v]) => ({ code, logo_url: v.logo_url, source: v.source, updated_at: new Date().toISOString() }))
  const wikidataN = records.filter(r => r.source === 'wikidata').length
  console.log(`採用: ${records.length}社（公式ロゴ ${wikidataN} / Clearbit ${records.length - wikidataN}）／JPX網羅率 ${(records.length / jpx.size * 100).toFixed(1)}%`)

  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500)
    const { error } = await sb.from('company_logo').upsert(chunk, { onConflict: 'code' })
    if (error) { console.error('upsert失敗', error.message); process.exit(1) }
    console.log(`  upsert ${Math.min(i + 500, records.length)}/${records.length}`)
  }
  console.log('完了')
}

main().catch(e => { console.error(e); process.exit(1) })
