import { NextRequest, NextResponse } from 'next/server'

// GoogleニュースRSSから銘柄別ニュースを取得する。
// 無料・キー不要・サーバー経由（CORS回避）。日経/ロイター/東洋経済等の見出しを拾える。
// 直近3ヶ月分を対象に、関連性の高い記事だけに絞り込み、新しい順で返す。
export const revalidate = 1800 // 30分キャッシュ

type Article = { title: string; link: string; source: string; pubDate: string }

// 投資視点のキーワード（銘柄名と組み合わせて関連ニュースに寄せる）
const FIN_KEYWORDS =
  '決算 OR 業績 OR 株価 OR 株式 OR 増益 OR 減益 OR 営業利益 OR 配当 OR 上方修正 OR 下方修正 OR 受注 OR 提携 OR 新製品 OR 発売 OR 開発'
// 同名の一般消費財ニュース（自動車レビュー等）を除外（例: 「IMV」がトヨタIMVを拾う問題対策）
const EXCLUDE = '-試乗 -新車 -中古車 -ランクル -ランドクルーザー -ハイラックス -ピックアップ'

// 「有名どころ・影響を与える」媒体の許可リスト（ソース名の部分一致・大小無視）。
// このいずれかに該当しない記事は、銘柄コードを含むか企業公式でない限り除外する。
const MAJOR_SOURCES = [
  '株探', 'かぶたん', 'yahoo', 'ファイナンス', '日本経済新聞', '日経', 'ロイター', 'reuters',
  'bloomberg', 'ブルームバーグ', '東洋経済', '四季報', 'ダイヤモンド', 'ログミー', 'みんかぶ',
  'トレーダーズ', 'フィスコ', 'ウエルスアドバイザー', 'アイフィス', '時事', '共同通信', 'nhk',
  '産経', '朝日新聞', '読売', '毎日新聞', '日刊工業', 'itmedia', '日経bp', 'newspicks',
  '株式新聞', '財経', 'モーニングスター', 'quick',
]

// 全角英数字を半角化して比較しやすくする
function normalize(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
}

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

  // 銘柄名（完全一致）＋（コード番号 または ファイナンス系キーワード）。直近90日。
  const codeClause = code ? `"${code}" OR ` : ''
  const query = `"${term}" (${codeClause}${FIN_KEYWORDS}) ${EXCLUDE} when:90d`
  const rssUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
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

    const nName = normalize(name)
    const articles: Article[] = []
    const seen = new Set<string>()
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

      // ── 関連性フィルタ ───────────────────────────────
      // (a) コード番号を含む（株探/Yahoo/日経DIGITAL等の確実な銘柄ニュース）
      const hasCode = !!code && (normalize(item).includes(code.toLowerCase()))
      // (b) 有名どころの媒体
      const nSource = normalize(source)
      const isMajor = MAJOR_SOURCES.some(m => nSource.includes(m))
      // (c) 企業公式（ソース名に銘柄名が含まれる＝自社発表）
      const isOfficial = !!nName && nName.length >= 2 && nSource.includes(nName)
      if (!hasCode && !isMajor && !isOfficial) continue

      // 重複（同一タイトル）除去
      const key = title.slice(0, 40)
      if (seen.has(key)) continue
      seen.add(key)

      articles.push({ title, link, source, pubDate })
    }

    // 新しい順に並べる（既定）
    articles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())

    return NextResponse.json({ articles: articles.slice(0, 30), query: term })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[news] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
