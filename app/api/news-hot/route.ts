import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ダッシュの「新着あり📰」用に、直近3日にニュースがある銘柄コードだけを軽量に返す。
// 記事本文は返さず code/pub_date のみ＝起動時に読んでも軽い。失敗時は空配列（無害）。
export const revalidate = 120 // 2分キャッシュ

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000 // 直近3日

export async function GET(_req: NextRequest) {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) return NextResponse.json({ codes: [] })
  try {
    const sb = createClient(url, anon, { auth: { persistSession: false } })
    // 新しい順に最近の2000件だけ（直近3日はこの範囲に十分入る）。code/pub_date のみ＝軽量。
    const { data, error } = await sb
      .from('stock_news')
      .select('code,pub_date')
      .order('pub_date', { ascending: false, nullsFirst: false })
      .range(0, 1999)
    if (error) throw error
    const now = Date.now()
    const set = new Set<string>()
    for (const r of (data ?? []) as { code: string; pub_date: string | null }[]) {
      if (!r.code || !r.pub_date) continue
      const t = new Date(r.pub_date).getTime()
      if (!Number.isNaN(t) && now - t < WINDOW_MS) set.add(r.code)
    }
    return NextResponse.json({ codes: Array.from(set) })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[news-hot] error:', msg)
    return NextResponse.json({ codes: [] })
  }
}
