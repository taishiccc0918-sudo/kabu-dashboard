import { NextRequest, NextResponse } from 'next/server'
import { fetchUsStockNews, translateTitlesJa } from '@/app/lib/news-us'

// 米国株1銘柄のニュース（詳細パネル用）。Google News米国版RSS・無料・キー不要。
export const revalidate = 1800 // 30分キャッシュ

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name')?.trim() || ''
  const ticker = req.nextUrl.searchParams.get('ticker')?.trim() || ''
  const fresh = req.nextUrl.searchParams.get('fresh') === '1'
  if (!name && !ticker) return NextResponse.json({ error: 'name or ticker required' }, { status: 400 })
  try {
    const articles = (await fetchUsStockNews(name || ticker, ticker, fresh)).slice(0, 30)
    // タイトルを日本語訳（日本人ユーザー向け）。失敗分は原文のまま。
    const ja = await translateTitlesJa(articles.map(a => a.title))
    articles.forEach((a, i) => { a.titleJa = ja[i] })
    return NextResponse.json({ articles, query: name || ticker })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[us-news] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
