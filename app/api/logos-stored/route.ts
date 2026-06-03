import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Supビルド済みの企業ロゴ・マスター（cronが収集）を code→URL の辞書で返す。
// テーブル未作成/未収集なら ready:false（フロントは色イニシャルチップにフォールバック）。
export const revalidate = 600 // ロゴは滅多に変わらないが、初回反映/月次更新を取りこぼさない程度に（10分）。

export async function GET(_req: NextRequest) {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) return NextResponse.json({ logos: {}, ready: false })

  try {
    const sb = createClient(url, anon, { auth: { persistSession: false } })
    const PAGE = 1000
    const MAX_PAGES = 8
    const logos: Record<string, string> = {}
    for (let p = 0; p < MAX_PAGES; p++) {
      const { data, error } = await sb
        .from('company_logo')
        .select('code,logo_url')
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) return NextResponse.json({ logos: {}, ready: false })
      if (!data || data.length === 0) break
      for (const r of data as { code: string; logo_url: string | null }[]) {
        if (r.logo_url) logos[r.code] = r.logo_url
      }
      if (data.length < PAGE) break
    }
    return NextResponse.json({ logos, ready: Object.keys(logos).length > 0 })
  } catch {
    return NextResponse.json({ logos: {}, ready: false })
  }
}
