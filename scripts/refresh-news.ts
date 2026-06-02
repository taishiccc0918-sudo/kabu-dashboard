/**
 * ニュース蓄積エンジン: 全お気に入り銘柄のニュースをGoogleニュースRSSから取得し、
 * Supabase `stock_news` に差分追記（linkで重複排除）。GitHub Actions（定期cron＋手動）から実行。
 *
 * 必要な環境変数（GitHub Secrets / ローカル.env）:
 *   SUPABASE_URL               … 例 https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  … service_role キー（RLSをバイパスして書き込み）
 *
 * 銘柄名は JPX 上場一覧（アプリの /api/listed-info と同じ）から取得する。
 * 取得・絞り込みロジックは app/lib/news.ts を共用（アプリと完全一致）。
 */
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { fetchStockNews } from '../app/lib/news'

function normalizeUrl(raw: string): string {
  let u = (raw ?? '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/\s+/g, '').replace(/\/+$/, '')
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u
  return u
}
const SUPABASE_URL = normalizeUrl(process.env.SUPABASE_URL ?? '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const FALLBACK_WATCHLIST = ['7203', '8306', '8058']
const CONCURRENCY = 6
const KEEP_DAYS = 120 // これより古い記事は削除（テーブル肥大化防止）

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('必須の環境変数が未設定です（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// JPX 上場一覧から code→銘柄名（アプリの listed-info と同じソース）
const JPX_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls'
async function getNameMap(): Promise<Record<string, string>> {
  try {
    const res = await fetch(JPX_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' } })
    if (!res.ok) throw new Error(`JPX ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const wb = XLSX.read(buf, { type: 'buffer' })
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })
    const map: Record<string, string> = {}
    for (const row of rows) {
      if (!row || row.length < 3) continue
      let code = String(row[1] ?? '').trim()
      const name = String(row[2] ?? '').trim()
      if (!/^[0-9A-Z]{3,5}$/.test(code) || !name) continue
      if (code.length === 5 && code.endsWith('0')) code = code.slice(0, 4)
      map[code] = name
    }
    return map
  } catch (e) {
    console.warn('JPX一覧の取得に失敗（名前なしで続行）:', (e as Error).message)
    return {}
  }
}

async function getUniverse(): Promise<string[]> {
  try {
    const { data, error } = await sb.from('favorites').select('code')
    if (error) throw error
    const set = new Set<string>(FALLBACK_WATCHLIST)
    for (const r of (data ?? []) as { code: string }[]) if (r.code) set.add(r.code)
    return Array.from(set)
  } catch (e) {
    console.warn('favorites取得失敗 → フォールバック使用:', (e as Error).message)
    return [...FALLBACK_WATCHLIST]
  }
}

type Row = {
  link: string; code: string; name: string; title: string
  source: string; source_url: string; pub_date: string | null; ir: boolean; disc: boolean
}

async function main() {
  const [universe, nameMap] = await Promise.all([getUniverse(), getNameMap()])
  console.log(`対象 ${universe.length} 銘柄のニュースを収集します`)

  const collected: Row[] = []
  let done = 0
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async code => {
      const name = nameMap[code] || code
      try {
        const arts = await fetchStockNews(name, code, true) // fresh=最新
        for (const a of arts) {
          let pub: string | null = null
          const t = new Date(a.pubDate).getTime()
          if (t && !Number.isNaN(t)) pub = new Date(t).toISOString()
          collected.push({
            link: a.link, code, name, title: a.title,
            source: a.source, source_url: a.sourceUrl, pub_date: pub, ir: a.ir, disc: a.disc,
          })
        }
      } catch (e) {
        console.warn(`  ${code} 取得失敗:`, (e as Error).message)
      }
    }))
    done += batch.length
    if (done % 30 === 0 || done >= universe.length) console.log(`  ${Math.min(done, universe.length)}/${universe.length}`)
    await sleep(300) // Googleへの一斉アクセスを少し緩める
  }

  // link重複を排除（同一記事が複数銘柄でヒットする場合は先勝ち）
  const byLink = new Map<string, Row>()
  for (const r of collected) if (!byLink.has(r.link)) byLink.set(r.link, r)
  const rows = [...byLink.values()]
  console.log(`収集 ${collected.length}件 → ユニーク ${rows.length}件 をupsertします`)

  // upsert（200件ずつ・linkで重複排除＝差分蓄積）
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const { error } = await sb.from('stock_news').upsert(chunk, { onConflict: 'link' })
    if (error) { console.error('upsert失敗:', error.message); process.exit(1) }
  }

  // 古い記事を削除（テーブル肥大化防止）
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString()
  const { error: delErr } = await sb.from('stock_news').delete().lt('pub_date', cutoff)
  if (delErr) console.warn('古い記事の削除に失敗:', delErr.message)

  console.log(`完了: ${rows.length}件を保存（${KEEP_DAYS}日より古い記事は削除）`)
}

main().catch(e => { console.error(e); process.exit(1) })
