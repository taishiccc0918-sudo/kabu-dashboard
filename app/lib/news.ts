// GoogleニュースRSSから銘柄別ニュースを取得・絞り込みする共通ロジック。
// 無料・キー不要・サーバー経由（CORS回避）。/api/news と /api/news-feed で共用。

export type Article = { title: string; link: string; source: string; sourceUrl: string; pubDate: string }

// 投資視点のキーワード（銘柄名と組み合わせて関連ニュースに寄せる）
const FIN_KEYWORDS =
  '決算 OR 業績 OR 株価 OR 株式 OR 増益 OR 減益 OR 営業利益 OR 配当 OR 上方修正 OR 下方修正 OR 受注 OR 提携 OR 新製品 OR 発売 OR 開発'
// 同名の一般消費財ニュース（自動車レビュー等）を除外（例: 「IMV」がトヨタIMVを拾う問題対策）
const EXCLUDE = '-試乗 -新車 -中古車 -ランクル -ランドクルーザー -ハイラックス -ピックアップ'

// 金融・主要メディア（ソース名の部分一致・大小無視）。
// 銘柄名が一般名詞（例:「カバー」）の場合に、化粧品PR等の非金融ソースを除外するための許可リスト。
// ※PR TIMES/アットプレス/タワレコ等の汎用配信元はあえて含めない（商品PRの誤混入源のため）。
const MAJOR_SOURCES = [
  '株探', 'かぶたん', 'yahoo', '日本経済新聞', '日経', 'ロイター', 'reuters',
  'bloomberg', 'ブルームバーグ', '東洋経済', '四季報', 'ダイヤモンド', 'ログミー', 'みんかぶ',
  'トレーダーズ', 'フィスコ', 'ウエルスアドバイザー', 'モーニングスター', 'アイフィス', '時事',
  '共同通信', 'nhk', '産経', '朝日新聞', '読売', '毎日新聞', '日刊工業', '株式新聞', 'quick',
]

// 全角英数字を半角化（例: ＩＭＶ → IMV）。Googleニュースの完全一致は全角だと0件になるため。
export function halfWidth(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}
// 比較用に半角化＋小文字化＋空白除去
function normalize(s: string): string {
  return halfWidth(s).toLowerCase().replace(/\s+/g, '')
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

// <source url="https://www.nikkei.com">日本経済新聞</source> の url 属性を取り出す（favicon用）
function pickSourceUrl(block: string): string {
  const m = block.match(/<source[^>]*\burl=["']([^"']+)["']/i)
  return m ? m[1] : ''
}

// 1銘柄分のニュースを取得し、関連性フィルタ済み・新しい順で返す。
// 取得失敗時は空配列（呼び出し側は止めない）。fresh=true で30分キャッシュを無視して最新を取る。
export async function fetchStockNews(name: string, code: string, fresh = false): Promise<Article[]> {
  const term = name || code
  if (!term) return []

  const qTerm = halfWidth(term)
  const codeClause = code ? `"${code}" OR ` : ''
  const query = `"${qTerm}" (${codeClause}${FIN_KEYWORDS}) ${EXCLUDE} when:90d`
  const rssUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`

  let xml: string
  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' },
      // fresh時はキャッシュ無視（更新ボタン用）。通常は30分キャッシュで再取得コストを抑える。
      ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: 1800 } }),
    })
    if (!res.ok) return []
    xml = await res.text()
  } catch {
    return []
  }

  const nName = normalize(name)
  const articles: Article[] = []
  const seen = new Set<string>()
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || []

  for (const item of items) {
    const rawTitle = pick(item, 'title')
    const link = pick(item, 'link')
    const pubDate = pick(item, 'pubDate')
    const source = pick(item, 'source')
    const sourceUrl = pickSourceUrl(item)
    if (!rawTitle || !link) continue

    // Googleニュースのtitleは「記事タイトル - メディア名」形式。末尾のメディア名を落とす
    const title = source && rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3))
      : rawTitle

    // ── 関連性フィルタ（タイトル基準で厳格に） ───────────────
    //  (a) タイトルにコード番号 → 採用（最も確実）
    //  (b) タイトルに銘柄名 かつ 金融・主要メディア → 採用
    //  (c) 企業公式（ソース名に銘柄名）→ 採用
    const nTitle = normalize(title)
    const nSource = normalize(source)
    const hasCodeTitle = !!code && nTitle.includes(code.toLowerCase())
    const hasNameTitle = nName.length >= 2 && nTitle.includes(nName)
    const isMajor = MAJOR_SOURCES.some(m => nSource.includes(m))
    const isOfficial = nName.length >= 2 && nSource.includes(nName)
    if (!hasCodeTitle && !(hasNameTitle && isMajor) && !isOfficial) continue

    const key = title.slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)

    articles.push({ title, link, source, sourceUrl, pubDate })
  }

  articles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
  return articles
}
