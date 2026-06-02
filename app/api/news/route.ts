import { NextRequest, NextResponse } from 'next/server'
import { fetchStockNews } from '@/app/lib/news'

// 1銘柄のニュース（詳細パネル用）。GoogleニュースRSS・無料・キー不要。
export const revalidate = 1800 // 30分キャッシュ

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name')?.trim() || ''
  const code = req.nextUrl.searchParams.get('code')?.trim() || ''
  if (!name && !code) {
    return NextResponse.json({ error: 'name or code required' }, { status: 400 })
  }
  try {
    const articles = await fetchStockNews(name, code)
    return NextResponse.json({ articles: articles.slice(0, 30), query: name || code })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[news] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
