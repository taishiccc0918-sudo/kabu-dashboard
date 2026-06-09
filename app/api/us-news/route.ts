import { NextRequest, NextResponse } from 'next/server'
import { fetchUsStockNews } from '@/app/lib/news-us'

// 米国株1銘柄のニュース（詳細パネル用）。Google News米国版RSS・無料・キー不要。
export const revalidate = 1800 // 30分キャッシュ

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name')?.trim() || ''
  const ticker = req.nextUrl.searchParams.get('ticker')?.trim() || ''
  const fresh = req.nextUrl.searchParams.get('fresh') === '1'
  if (!name && !ticker) return NextResponse.json({ error: 'name or ticker required' }, { status: 400 })
  try {
    const articles = await fetchUsStockNews(name || ticker, ticker, fresh)
    return NextResponse.json({ articles: articles.slice(0, 30), query: name || ticker })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[us-news] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
