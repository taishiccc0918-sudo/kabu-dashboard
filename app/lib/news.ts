// GoogleニュースRSSから銘柄別ニュースを取得・絞り込みする共通ロジック。
// 無料・キー不要・サーバー経由（CORS回避）。/api/news と /api/news-feed で共用。

export type Article = { title: string; link: string; source: string; sourceUrl: string; pubDate: string; ir: boolean; disc: boolean }

// 決算・適時開示の判定キーワード（媒体不問。日経会社情報DIGITAL/株探等が全社分を配信）
const DISCLOSURE_RE = /適時開示|決算短信|決算説明|決算発表|決算速報|本決算|四半期|業績予想|配当予想|増配|減配|自己株式|株主総会|有価証券報告書|公開買付|ＴＯＢ|TOB|株式分割|新株予約権|月次|上方修正|下方修正|開示資料/i

// 投資視点のキーワード（銘柄名と組み合わせて関連ニュースに寄せる）
const FIN_KEYWORDS =
  '決算 OR 業績 OR 株価 OR 株式 OR 増益 OR 減益 OR 営業利益 OR 配当 OR 上方修正 OR 下方修正 OR 受注 OR 提携 OR 新製品 OR 発売 OR 開発'
// 事業・コーポレート系キーワード（FIN_KEYWORDSとは別の上位100件を引いて媒体多様化・取りこぼし減）
const BIZ_KEYWORDS =
  '買収 OR M&A OR TOB OR 出資 OR 資本提携 OR 業務提携 OR 子会社 OR 増産 OR 新工場 OR 設備投資 OR 公募 OR 自社株買い OR 株主還元 OR 新サービス OR 値上げ OR リコール OR 訴訟 OR 不祥事 OR 業績予想 OR 中期経営計画'
// 同名の一般消費財ニュース（自動車レビュー等）を除外（例: 「IMV」がトヨタIMVを拾う問題対策）
const EXCLUDE = '-試乗 -新車 -中古車 -ランクル -ランドクルーザー -ハイラックス -ピックアップ'

// 信頼できる主要メディア（ソース名の部分一致・大小無視）。
// 「重要ニュースは本文で銘柄が出るものも拾う」ため、これら主要メディアは
// タイトルに銘柄名が無くても本文にコードが出れば採用する（質を保ちつつ網羅性UP）。
// マイナーサイト・商品PR配信元（アットプレス/タワレコ等）はあえて含めない。
const MAJOR_SOURCES = [
  // 経済・金融専門
  '株探', 'かぶたん', 'yahoo', '日本経済新聞', '日経', '東洋経済', '会社四季報', '四季報',
  'ダイヤモンド', 'ログミー', 'みんかぶ', 'トレーダーズ', 'フィスコ', 'ウエルスアドバイザー',
  'モーニングスター', 'アイフィス', '株式新聞', 'quick', 'kabutan', 'zuu', 'finasee',
  'マネークリップ', 'マネーポスト', 'プレジデント', '日経ビジネス', '日経クロステック', '日経xtech',
  '日刊工業', 'newspicks', 'ニュースイッチ', '財新', 'sbi', '楽天証券', 'マネックス',
  // 通信社・全国紙・放送（国内）
  'ロイター', 'reuters', 'bloomberg', 'ブルームバーグ', '時事', '時事通信', 'jiji', '共同通信', '共同', 'kyodo',
  'nhk', '産経', '朝日新聞', '朝日', '読売', '毎日新聞', '毎日', 'テレ東', 'wbs', 'tbs', 'fnn', 'ann', '日テレ', 'テレビ東京',
  // 海外・経済メディア（日経/Yahoo偏重をやめ多様化するため明示的に主要海外メディアを優遇）
  'cnbc', 'wsj', 'wall street', 'financial times', 'フィナンシャル・タイムズ', 'ft',
  'nikkei asia', '日経asia', 'forbes', 'フォーブス', 'business insider', 'ビジネスインサイダー',
  'cnn', 'bbc', '日経ヴェリタス', '日経veritas',
  // 信用調査・産業
  '東京商工リサーチ', '帝国データバンク', 'tdb', 'jcネット', 'jcn',
  // IT・産業専門
  'itmedia', 'impress', 'pc watch', '日経xtech', 'eetimes', 'マイナビ', 'response',
  'ascii', 'gigazine', 'techcrunch', '電波新聞', '日経電子版', 'dmenu', 'ｄメニュー',
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

// GoogleニュースRSSを1クエリ取得して生XMLを返す（失敗時は空文字）。
async function fetchRss(query: string, fresh: boolean): Promise<string> {
  const rssUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`
  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' },
      // fresh時はキャッシュ無視（更新ボタン用）。通常は30分キャッシュで再取得コストを抑える。
      ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: 1800 } }),
    })
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  }
}

// 1件のRSS itemを関連性判定し、採用なら articles に push（seenで重複排除）。
function collectFromXml(xml: string, name: string, code: string, articles: Article[], seen: Set<string>): void {
  const nName = normalize(name)
  const codeLc = code.toLowerCase()
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

    const nTitle = normalize(title)
    const nSource = normalize(source)
    const nItem = normalize(item)
    const hasNameTitle = nName.length >= 2 && nTitle.includes(nName)
    const isMajor = MAJOR_SOURCES.some(m => nSource.includes(m))
    const isOfficial = nName.length >= 2 && nSource.includes(nName)
    // タイトルまたは本文にコード番号（ティッカー）が出る＝確実にこの銘柄の記事。
    // 媒体不問で採用する（日経/PR TIMES/株探等、ティッカーが入っていれば漏れなく拾う）。
    const hasCode = !!code && nItem.includes(codeLc)

    // ── 別銘柄のクオート/関連ページ除外 ──
    // タイトルに【別コード】が入り、対象銘柄の名前・コードが無いものは別銘柄の記事（REIT/ETF等）→除外
    const bracketCodes = (title.match(/[【\[]\s*([0-9][0-9A-Za-z]{2,4})\s*[】\]]/g) || [])
      .map(b => b.replace(/[^0-9A-Za-z]/g, '').toLowerCase())
    const hasOtherSecurityOnly =
      bracketCodes.length > 0 && !bracketCodes.includes(codeLc) && !hasNameTitle

    // 銘柄名が「固有名」か（4文字以上＝東京精密/サンリオ等）。短い/一般語（カバー/IMV/TDK）は
    // タイトル一致だけでは信用せず主要メディアを要求する（「ブックカバー」等の誤マッチを防ぐ）。
    const distinctive = nName.length >= 4
    const nameTitleOK = hasNameTitle && (distinctive || isMajor)

    // ── 関連性フィルタ ───────────────────────────────
    //  採用: 本文/タイトルにコード(ティッカー) / 固有名はタイトル一致・一般語は主要メディア＋タイトル一致 / 企業公式
    //  除外: 別銘柄のクオート/関連ページ
    if (hasOtherSecurityOnly) continue
    if (!hasCode && !nameTitleOK && !isOfficial) continue

    // 重複排除は「正規化タイトル」基準（多クエリfan-outで同一記事がGoogleの別リンクで再出現するため、
    // リンク基準だと同じ見出しが重複する＝旧バグ）。fetchStockNewsは銘柄単位なのでタイトル重複＝同記事。
    const key = nTitle || link
    if (seen.has(key)) continue
    seen.add(key)

    // IR・公式発表の判定 = 企業公式サイト発のみ（ソース名に社名が含まれる）。
    // ※日経会社情報DIGITAL等の「適時開示の転載」はメディア発なのでIRに含めない（本人指摘）。
    const ir = isOfficial
    const disc = DISCLOSURE_RE.test(title)

    articles.push({ title, link, source, sourceUrl, pubDate, ir, disc })
  }
}

// 1銘柄分のニュースを取得し、関連性フィルタ済み・新しい順で返す。
// 取得失敗時は空配列（呼び出し側は止めない）。fresh=true で30分キャッシュを無視して最新を取る。
//
// 【網羅性のための多クエリfan-out】GoogleニュースRSSは1クエリ最大約100件で頭打ちになるため、
// 「財務系」「事業・コーポレート系」の2クエリを別々に引いて結果を合算する。クエリ毎に上位100件の
// 顔ぶれ（媒体）が変わるので、件数増＋媒体多様化（日経/Yahoo偏重の緩和）の両方に効く。
export async function fetchStockNews(name: string, code: string, fresh = false): Promise<Article[]> {
  const term = name || code
  if (!term) return []

  const qTerm = halfWidth(term)
  const codeClause = code ? `"${code}" OR ` : ''
  const queries = [
    `"${qTerm}" (${codeClause}${FIN_KEYWORDS}) ${EXCLUDE} when:90d`,
    `"${qTerm}" (${codeClause}${BIZ_KEYWORDS}) ${EXCLUDE} when:90d`,
  ]

  const articles: Article[] = []
  const seen = new Set<string>()
  // クエリは並列取得（Googleへの一斉負荷は2本/銘柄に留まる）
  const xmls = await Promise.all(queries.map(q => fetchRss(q, fresh)))
  for (const xml of xmls) {
    if (xml) collectFromXml(xml, name, code, articles, seen)
  }

  articles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
  return articles
}
