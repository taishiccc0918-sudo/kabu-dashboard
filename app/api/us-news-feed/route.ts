import { NextRequest, NextResponse } from 'next/server'
import { fetchUsStockNews, translateTitlesJa } from '@/app/lib/news-us'
import type { Article } from '@/app/lib/news'

// 米国株お気に入りのニュースをまとめて取得し新着順に返す（一覧フィード用・ライブ）。
// クライアントから {stocks:[{code(=ticker),name}]} をPOST。各銘柄30分キャッシュで軽い。
export const maxDuration = 60

type FeedItem = Article & { code: string; name: string }
type Stock = { code: string; name: string }

async function pool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let idx = 0
  async function run(): Promise<void> {
    while (idx < items.length) { const cur = idx++; results[cur] = await worker(items[cur]) }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

export async function POST(req: NextRequest) {
  let stocks: Stock[] = []
  let fresh = false
  try {
    const body = await req.json()
    stocks = Array.isArray(body?.stocks) ? body.stocks : []
    fresh = body?.fresh === true
  } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  stocks = stocks.filter((s): s is Stock => !!s && typeof s.code === 'string').slice(0, 120)
  if (stocks.length === 0) return NextResponse.json({ items: [], count: 0 })

  try {
    const perStock = await pool(stocks, 8, async (s) => {
      const arts = await fetchUsStockNews(s.name || s.code, s.code, fresh)
      return arts.slice(0, 40).map((a): FeedItem => ({ ...a, code: s.code, name: s.name || s.code }))
    })
    const seen = new Set<string>()
    const merged: FeedItem[] = []
    for (const item of perStock.flat()) {
      const key = item.link || item.title.slice(0, 40)
      if (seen.has(key)) continue
      seen.add(key); merged.push(item)
    }
    merged.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0))
    const items = merged.slice(0, 3000)
    // 上位（表示されやすい）ぶんのタイトルを日本語訳。残りは原文（クライアントで表示時はtitleJa||title）。
    const TRANSLATE = 120
    const ja = await translateTitlesJa(items.slice(0, TRANSLATE).map(a => a.title))
    items.slice(0, TRANSLATE).forEach((a, i) => { a.titleJa = ja[i] })
    return NextResponse.json({ items, count: merged.length })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[us-news-feed] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
