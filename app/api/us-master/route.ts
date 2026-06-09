import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// 全米上場マスター（us_master）を全件返す。日本株の /api/listed-info に相当。
// 件数が多い(~10k)ため range でページ分割して集める。匿名キーで読み取り（公開データ）。
// 注意: ビルド時に静的プリレンダされると「テーブル空のまま固定」されてしまうため force-dynamic。
// クライアントは1セッション1回しか呼ばないので毎リクエストSupabase照会でも負荷は小さい。
export const dynamic = 'force-dynamic'

type Row = { ticker: string; name: string | null; exchange: string | null; mcap: number | null; sic_label: string | null; name_kana: string | null }

export async function GET(_req: NextRequest) {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) return NextResponse.json({})
  try {
    const sb = createClient(url, anon, { auth: { persistSession: false } })
    const PAGE = 1000
    const MAX_PAGES = 30
    const out: Record<string, { name: string; market: string; mcap: number | null; sicLabel: string | null; nameKana: string | null }> = {}
    for (let p = 0; p < MAX_PAGES; p++) {
      const { data, error } = await sb
        .from('us_master')
        .select('ticker,name,exchange,mcap,sic_label,name_kana')
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) throw error
      const chunk = (data ?? []) as Row[]
      for (const r of chunk) {
        if (!r.ticker) continue
        out[r.ticker] = { name: r.name ?? r.ticker, market: r.exchange ?? '', mcap: r.mcap ?? null, sicLabel: r.sic_label ?? null, nameKana: r.name_kana ?? null }
      }
      if (chunk.length < PAGE) break
    }
    return NextResponse.json(out)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[us-master] error:', msg)
    return NextResponse.json({})
  }
}
