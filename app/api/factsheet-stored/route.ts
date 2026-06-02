import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Supabaseに蓄積済みの「企業ファクトシート」（EDINET有報由来）を1銘柄分読み取って返す。
// 数値（売上/利益）はフロントがJ-Quantsから即時表示するため、ここはEDINET由来の会社概要のみ。
// 【捏造ゼロ】値は cron 収集スクリプト（EDINET一次情報の機械抽出）が書いたものだけ。ここでは整形のみ。
//
// 状態の意味（フロントの表示分岐に対応）:
//   ready:false … テーブル未作成 or 当該銘柄が未収集 → フロントは「取得待ち」表示（嘘をつかない）
//   ready:true, item:null は返さない（未収集は ready:false に倒す）
//   ready:true, item:{...} … 収集済み。各フィールドが null の項目はフロントで「データなし」表示
export const revalidate = 3600 // 有報は年1回更新。1時間キャッシュで十分

export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get('code') ?? '').trim()
  if (!code) return NextResponse.json({ ready: false, item: null })

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) return NextResponse.json({ ready: false, item: null })

  try {
    const sb = createClient(url, anon, { auth: { persistSession: false } })
    const { data, error } = await sb
      .from('company_factsheet')
      .select('code,biz_desc,ceo,founded,employees,employees_as_of,segments,doc_url,doc_date')
      .eq('code', code)
      .maybeSingle()
    // テーブル未作成（EDINET連携セットアップ前）やエラー時は「取得待ち」に倒す
    if (error || !data) return NextResponse.json({ ready: false, item: null })

    const item = {
      code: data.code,
      bizDesc: data.biz_desc ?? null,
      ceo: data.ceo ?? null,
      founded: data.founded ?? null,
      employees: data.employees ?? null,
      employeesAsOf: data.employees_as_of ?? null,
      segments: (data.segments as { name: string; sales: number | null }[] | null) ?? null,
      docUrl: data.doc_url ?? null,
      docDate: data.doc_date ?? null,
    }
    return NextResponse.json({ ready: true, item })
  } catch {
    return NextResponse.json({ ready: false, item: null })
  }
}
