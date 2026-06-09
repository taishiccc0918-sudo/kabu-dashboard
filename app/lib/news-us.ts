// 米国株ニュース取得（Google News 米国版RSS・無料・キー不要）。
// 日本株(news.ts)とは別実装。英語社名＋ティッカーで検索し、関連記事を返す。
import type { Article } from './news'

function pick(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
  if (!m) return ''
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
}
function pickSourceUrl(item: string): string {
  const m = item.match(/<source url="([^"]+)"/)
  return m ? m[1] : ''
}

// 英語社名から法人格や記号を落として主要語を作る（検索/関連判定用）
function coreName(name: string): string {
  return name
    .replace(/\b(Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|LLC|PLC|Holdings?|Group|Class [A-Z]|The)\b\.?/gi, ' ')
    .replace(/[.,&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchRss(query: string, fresh: boolean): Promise<string> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' },
      ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: 1800 } }),
    })
    if (!res.ok) return ''
    return await res.text()
  } catch { return '' }
}

// ticker と社名の主要語で関連性をゆるく判定（同名異物の混入を抑える）
function isRelevant(title: string, core: string, ticker: string): boolean {
  const t = title.toLowerCase()
  if (t.includes(`$${ticker.toLowerCase()}`)) return true
  if (new RegExp(`\\b${ticker.toLowerCase()}\\b`).test(t)) return true
  const words = core.toLowerCase().split(' ').filter(w => w.length >= 3)
  if (words.length === 0) return true
  // 主要語の先頭1〜2語が含まれていれば採用
  return words.slice(0, 2).every(w => t.includes(w)) || (words[0] ? t.includes(words[0]) : false)
}

// 主要メディア（米国投資家がよく見る一次・大手）。表示順で優先する。
const MAJOR_US_SOURCES = ['reuters', 'bloomberg', 'cnbc', 'wall street journal', 'wsj', 'financial times', 'barron', 'marketwatch', 'the motley fool', 'forbes', 'business insider', 'associated press', 'yahoo finance', 'investor', '日経', 'nikkei', 'bloomberg.co.jp']

// 無料のGoogle翻訳(gtx)でタイトルを日本語化。失敗時は原文のまま。
async function translateOne(text: string): Promise<string> {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text)}`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 kabu-dashboard' }, next: { revalidate: 86400 } })
    if (!res.ok) return text
    const j = await res.json() as unknown[]
    const segs = (j[0] as unknown[]) ?? []
    const ja = segs.map(s => (Array.isArray(s) ? (s[0] as string) : '')).join('')
    return ja || text
  } catch { return text }
}
export async function translateTitlesJa(titles: string[]): Promise<string[]> {
  const out: string[] = new Array(titles.length)
  let idx = 0
  const CONC = 8
  async function run() { while (idx < titles.length) { const i = idx++; out[i] = await translateOne(titles[i]) } }
  await Promise.all(Array.from({ length: Math.min(CONC, titles.length) }, run))
  return out
}

export async function fetchUsStockNews(name: string, ticker: string, fresh = false): Promise<Article[]> {
  const core = coreName(name) || ticker
  // ①投資系クエリ ②一般ニュース（Reuters/Bloomberg等の大手も拾う）の2本を統合
  const [xml1, xml2] = await Promise.all([
    fetchRss(`"${core}" (stock OR shares OR earnings OR results OR revenue OR Nasdaq OR NYSE) when:120d`, fresh),
    fetchRss(`"${core}" (Reuters OR Bloomberg OR CNBC OR business OR company) when:120d`, fresh),
  ])
  const items = [...(xml1.match(/<item>([\s\S]*?)<\/item>/g) || []), ...(xml2.match(/<item>([\s\S]*?)<\/item>/g) || [])]
  const out: Article[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const rawTitle = pick(item, 'title')
    const link = pick(item, 'link')
    const pubDate = pick(item, 'pubDate')
    const source = pick(item, 'source')
    const sourceUrl = pickSourceUrl(item)
    if (!rawTitle || !link) continue
    // Googleニュースのtitleは「記事タイトル - メディア名」。末尾のメディア名を落とす
    const title = source && rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle
    if (!isRelevant(title, core, ticker)) continue
    const key = title.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title, link, source: source || '', sourceUrl, pubDate, ir: false, disc: false })
  }
  // 新しい順
  out.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0))
  return out.slice(0, 40)
}
