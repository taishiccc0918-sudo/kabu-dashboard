/**
 * ニュース網羅性のA/B計測（一時スクリプト・本番DB非依存）。
 *  OLD = 旧ロジック相当（GoogleニュースRSS 単一クエリ・FIN_KEYWORDSのみ・1銘柄100件）
 *  NEW = 新ロジック（fetchStockNews=2クエリfan-out ＋ fetchTdnet=適時開示一次ソース）
 * 同一サンプル銘柄で取得量・媒体多様化・IR/適時開示件数を比較する。
 *   実行: npx tsx scripts/measure-news.ts
 */
import { fetchStockNews, halfWidth } from '../app/lib/news'
import { fetchTdnet } from '../app/lib/tdnet'

// 代表サンプル（業種を散らす）。名前は固定（JPXフェッチ依存を避ける）。
const SAMPLE: [string, string][] = [
  ['7203', 'トヨタ自動車'], ['8306', '三菱ＵＦＪフィナンシャル・グループ'], ['8058', '三菱商事'],
  ['6758', 'ソニーグループ'], ['9984', 'ソフトバンクグループ'], ['6501', '日立製作所'],
  ['7974', '任天堂'], ['9433', 'ＫＤＤＩ'], ['4063', '信越化学工業'],
  ['6098', 'リクルートホールディングス'], ['9101', '日本郵船'], ['6857', 'アドバンテスト'],
  ['7011', '三菱重工業'], ['4661', 'オリエンタルランド'], ['8035', '東京エレクトロン'],
]

const FIN_KEYWORDS =
  '決算 OR 業績 OR 株価 OR 株式 OR 増益 OR 減益 OR 営業利益 OR 配当 OR 上方修正 OR 下方修正 OR 受注 OR 提携 OR 新製品 OR 発売 OR 開発'
const EXCLUDE = '-試乗 -新車 -中古車 -ランクル -ランドクルーザー -ハイラックス -ピックアップ'

function norm(s: string) { return halfWidth(s).toLowerCase().replace(/\s+/g, '') }

// 旧ロジック: 単一クエリでRSSを引き、件数とソースだけ数える（フィルタは緩め＝旧と同等の母数感）
async function oldFetch(name: string, code: string): Promise<{ title: string; source: string }[]> {
  const q = `"${halfWidth(name)}" ("${code}" OR ${FIN_KEYWORDS}) ${EXCLUDE} when:90d`
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' }, cache: 'no-store' })
    if (!res.ok) return []
    const xml = await res.text()
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []
    const out: { title: string; source: string }[] = []
    const seen = new Set<string>()
    const nName = norm(name); const codeLc = code.toLowerCase()
    for (const it of items) {
      const tm = it.match(/<title[^>]*>([\s\S]*?)<\/title>/i); const sm = it.match(/<source[^>]*>([\s\S]*?)<\/source>/i)
      let title = (tm?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
      const source = (sm?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
      if (!title) continue
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3))
      // 旧フィルタ相当（コード本文 or 固有名タイトル一致）
      const nItem = norm(it); const nTitle = norm(title)
      const hasCode = nItem.includes(codeLc)
      const hasName = nName.length >= 4 && nTitle.includes(nName)
      if (!hasCode && !hasName) continue
      const k = title.slice(0, 40); if (seen.has(k)) continue; seen.add(k)
      out.push({ title, source })
    }
    return out.slice(0, 100)
  } catch { return [] }
}

const sinceMs = Date.now() - 120 * 86400000
function tally(rows: { source: string; ir?: boolean; disc?: boolean }[]) {
  const media = new Map<string, number>()
  let ir = 0, disc = 0
  for (const r of rows) {
    media.set(r.source || '(なし)', (media.get(r.source || '(なし)') || 0) + 1)
    if (r.ir) ir++; if (r.disc) disc++
  }
  const yn = (media.get('Yahoo!ファイナンス') || 0) + (media.get('Yahoo!ニュース') || 0) + (media.get('日本経済新聞') || 0)
  return { total: rows.length, media: media.size, ir, disc, yahooNikkei: yn, mediaMap: media }
}

async function main() {
  let oldRows: { source: string; ir?: boolean; disc?: boolean }[] = []
  let newRows: { source: string; ir?: boolean; disc?: boolean }[] = []
  for (const [code, name] of SAMPLE) {
    const [o, g, t] = await Promise.all([
      oldFetch(name, code),
      fetchStockNews(name, code, true),
      fetchTdnet(name, code, sinceMs, 100),
    ])
    oldRows.push(...o)
    newRows.push(...g, ...t)
    process.stdout.write(`  ${code} ${name}: OLD ${o.length} / NEW google ${g.length}+tdnet ${t.length}\n`)
    await new Promise(r => setTimeout(r, 400))
  }
  const O = tally(oldRows); const N = tally(newRows)
  const pct = (a: number, b: number) => b ? `${Math.round(a / b * 100)}%` : '0%'
  console.log('\n================ A/B 結果（サンプル15銘柄） ================')
  console.log('項目                |   OLD   |   NEW   |  差')
  console.log(`取得件数            | ${String(O.total).padStart(6)} | ${String(N.total).padStart(6)} | +${N.total - O.total}`)
  console.log(`媒体数（ユニーク）  | ${String(O.media).padStart(6)} | ${String(N.media).padStart(6)} | +${N.media - O.media}`)
  console.log(`IR/公式発          | ${String(O.ir).padStart(6)} | ${String(N.ir).padStart(6)} | +${N.ir - O.ir}`)
  console.log(`決算・適時開示      | ${String(O.disc).padStart(6)} | ${String(N.disc).padStart(6)} | +${N.disc - O.disc}`)
  console.log(`Yahoo+日経の占有率  | ${pct(O.yahooNikkei, O.total).padStart(6)} | ${pct(N.yahooNikkei, N.total).padStart(6)} |`)
  const top = [...N.mediaMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  console.log('\n--- NEW 媒体TOP15 ---')
  for (const [s, n] of top) console.log(String(n).padStart(5), s)
}
main().catch(e => { console.error(e); process.exit(1) })
