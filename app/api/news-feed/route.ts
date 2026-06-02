import { NextRequest, NextResponse } from 'next/server'
import { fetchStockNews, Article } from '@/app/lib/news'

// お気に入り銘柄のニュースをまとめて取得し、新着順にマージして返す（一覧フィード用）。
// クライアントから {stocks:[{code,name}]} をPOST。サーバー側で同時実行数を絞って取得し、
// 各銘柄は30分キャッシュ（fetchStockNews内）されるため繰り返し呼び出しは軽い。
export const maxDuration = 60

type FeedItem = Article & { code: string; name: string }
type Stock = { code: string; name: string }

// 同時実行数を絞ったプール（Googleへの一斉アクセス・レート制限を避ける）
async function pool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let idx = 0
  async function run(): Promise<void> {
    while (idx < items.length) {
      const cur = idx++
      results[cur] = await worker(items[cur])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

export async function POST(req: NextRequest) {
  let stocks: Stock[]
  try {
    const body = await req.json()
    stocks = Array.isArray(body?.stocks) ? body.stocks : []
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  // 安全のため最大件数を制限（暴走・過負荷防止）
  stocks = stocks
    .filter((s): s is Stock => !!s && typeof s.code === 'string')
    .slice(0, 250)

  if (stocks.length === 0) {
    return NextResponse.json({ items: [], count: 0 })
  }

  try {
    const perStock = await pool(stocks, 8, async (s) => {
      const arts = await fetchStockNews(s.name || '', s.code)
      // 1銘柄あたり上限を設けてフィードが特定銘柄で埋まらないようにする
      return arts.slice(0, 8).map((a): FeedItem => ({ ...a, code: s.code, name: s.name || s.code }))
    })

    // マージ＋重複除去（同一リンク／同一タイトル先頭）＋新着順
    const seen = new Set<string>()
    const merged: FeedItem[] = []
    for (const item of perStock.flat()) {
      const key = item.link || item.title.slice(0, 40)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
    merged.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())

    return NextResponse.json({ items: merged.slice(0, 150), count: merged.length })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[news-feed] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
