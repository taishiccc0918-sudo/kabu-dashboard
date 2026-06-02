import { NextRequest, NextResponse } from 'next/server'

// GoogleニュースRSSから銘柄別ニュースを取得する。
// 無料・キー不要・サーバー経由（CORS回避）。日経/ロイター/東洋経済等の見出しを拾える。
export const revalidate = 1800 // 30分キャッシュ

type Article = { title: string; link: string; source: string; pubDate: string }

// 最小限のHTMLエンティティ復号（RSSのtitle/sourceに混入する範囲のみ）
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decodeEntities(m[1]) : ''
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name')?.trim() || ''
  const code = req.nextUrl.searchParams.get('code')?.trim() || ''
  const term = name || code
  if (!term) {
    return NextResponse.json({ error: 'name or code required' }, { status: 400 })
  }

  // 投資視点のニュースに寄せる: 銘柄名（完全一致）＋ファイナンス系キーワードのいずれか
  const query = `"${term}" (株価 OR 決算 OR 業績 OR 受注 OR 提携 OR 新製品 OR 開発 OR 上方修正 OR 増配)`
  const rssUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:30d')}` +
    `&hl=ja&gl=JP&ceid=JP:ja`

  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' },
      next: { revalidate: 1800 },
    })
    if (!res.ok) {
      return NextResponse.json({ error: `Google News fetch failed: ${res.status}` }, { status: 502 })
    }
    const xml = await res.text()

    const articles: Article[] = []
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []
    for (const item of items) {
      const rawTitle = pick(item, 'title')
      const link = pick(item, 'link')
      const pubDate = pick(item, 'pubDate')
      const source = pick(item, 'source')
      if (!rawTitle || !link) continue
      // Googleニュースのtitleは「記事タイトル - メディア名」形式。末尾のメディア名を落とす
      const title = source && rawTitle.endsWith(` - ${source}`)
        ? rawTitle.slice(0, -(source.length + 3))
        : rawTitle
      articles.push({ title, link, source, pubDate })
      if (articles.length >= 12) break
    }

    return NextResponse.json({ articles, query: term })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[news] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
