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

export async function fetchUsStockNews(name: string, ticker: string, fresh = false): Promise<Article[]> {
  const core = coreName(name) || ticker
  const query = `"${core}" (stock OR shares OR earnings OR NASDAQ OR NYSE OR revenue) when:120d`
  const xml = await fetchRss(query, fresh)
  if (!xml) return []
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []
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
