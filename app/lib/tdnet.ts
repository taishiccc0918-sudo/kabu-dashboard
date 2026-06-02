// TDnet（適時開示）の一次ソースから銘柄別の開示を取得する。
// 提供: Yanoshin TDnet WebAPI（無料・キー不要）https://webapi.yanoshin.jp/
// これにより「IR・適時開示は漏れなく全部」を一次情報から実現する（Googleニュースの偶然ヒット依存をやめる）。
//
// 返すのは news.ts の Article と互換の形（ir=true, disc=true 固定。媒体=企業名）。

import type { Article } from './news'

type YanoTdnet = {
  id?: string
  title?: string
  company_code?: string
  company_name?: string
  pubdate?: string        // 例: "2026-05-08 13:55:00"（JST, タイムゾーン表記なし）
  document_url?: string   // 例: https://webapi.yanoshin.jp/rd.php?https://www.release.tdnet.info/inbs/xxxx.pdf
  url?: string
}

// "2026-05-08 13:55:00"(JST) → ISO文字列。失敗時は空文字。
function jstToIso(s: string): string {
  const m = (s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return ''
  const [, y, mo, d, h, mi, se] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${se}+09:00`
}

// Yanoshinのdocument_urlは "rd.php?<本来のtdnet.info URL>" 形式。中の本URLを取り出す（重複排除キーを安定させる）。
function unwrapUrl(raw: string): string {
  if (!raw) return ''
  const i = raw.indexOf('rd.php?')
  if (i >= 0) {
    const inner = raw.slice(i + 'rd.php?'.length)
    if (/^https?:\/\//i.test(inner)) return inner
  }
  return raw
}

// 5桁証券コード(72030)→4桁(7203)。すでに4桁ならそのまま。
function normCode(c: string): string {
  const t = (c || '').trim()
  if (/^[0-9A-Za-z]{5}$/.test(t) && t.endsWith('0')) return t.slice(0, 4)
  return t
}

// 1銘柄分の適時開示を取得（sinceMs より新しいものだけ）。失敗時は空配列。
export async function fetchTdnet(name: string, code: string, sinceMs: number, limit = 100): Promise<Article[]> {
  if (!code) return []
  const url = `https://webapi.yanoshin.jp/webapi/tdnet/list/${encodeURIComponent(code)}.json?limit=${limit}`
  let json: { items?: { Tdnet?: YanoTdnet }[] }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' },
      next: { revalidate: 1800 },
    })
    if (!res.ok) return []
    json = await res.json()
  } catch {
    return []
  }

  const out: Article[] = []
  const seen = new Set<string>()
  for (const it of json.items ?? []) {
    const t = it.Tdnet ?? (it as unknown as YanoTdnet)
    const title = (t.title ?? '').trim()
    const link = unwrapUrl(t.document_url ?? t.url ?? '')
    if (!title || !link) continue
    const iso = jstToIso(t.pubdate ?? '')
    if (iso) {
      const ms = new Date(iso).getTime()
      if (!Number.isNaN(ms) && ms < sinceMs) continue // 期間外は捨てる
    }
    if (seen.has(link)) continue
    seen.add(link)
    out.push({
      title,
      link,
      source: name || t.company_name || '適時開示',
      sourceUrl: 'https://www.release.tdnet.info', // favicon用
      pubDate: iso,
      ir: true,   // 一次ソースの正式開示＝公式発表
      disc: true, // 決算・適時開示
    })
  }
  return out
}

export { normCode as normTdnetCode }
