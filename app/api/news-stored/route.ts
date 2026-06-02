import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Supabaseに蓄積済みのニュースを読み取って返す（cronが裏で収集したもの）。
// ブラウザは初回からこれを読むだけ＝即表示・全件・軽い。
export const revalidate = 60 // 1分キャッシュ（DBは2時間ごと更新なので十分）

type StoredRow = {
  link: string; code: string; name: string | null; title: string
  source: string | null; source_url: string | null; pub_date: string | null; ir: boolean; disc: boolean
}

export async function GET(_req: NextRequest) {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) {
    return NextResponse.json({ items: [], count: 0, ready: false })
  }
  try {
    const sb = createClient(url, anon, { auth: { persistSession: false } })
    // Supabase(PostgREST)は1リクエスト最大1000行のため、range でページ分割して集める。
    // 旧仕様は6000件で頭打ち（古い記事が切り捨て）だった。蓄積DBを実質全件返すため上限を大幅引き上げ。
    // ※20000は暴走防止の安全弁。通常はDB件数に達した時点で break する。
    const PAGE = 1000
    const MAX_PAGES = 20
    const rows: StoredRow[] = []
    for (let p = 0; p < MAX_PAGES; p++) {
      const { data, error } = await sb
        .from('stock_news')
        .select('link,code,name,title,source,source_url,pub_date,ir,disc')
        .order('pub_date', { ascending: false, nullsFirst: false })
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) throw error
      const chunk = (data ?? []) as StoredRow[]
      rows.push(...chunk)
      if (chunk.length < PAGE) break // 最終ページ
    }
    const items = rows.map(r => ({
      title: r.title, link: r.link, source: r.source ?? '', sourceUrl: r.source_url ?? '',
      pubDate: r.pub_date ?? '', code: r.code, name: r.name ?? r.code, ir: r.ir, disc: r.disc,
    }))
    return NextResponse.json({ items, count: items.length, ready: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[news-stored] error:', msg)
    return NextResponse.json({ items: [], count: 0, ready: false, error: msg })
  }
}
