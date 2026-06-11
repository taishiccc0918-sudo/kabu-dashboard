// ── AI系 API の認証＋日次レート制限ガード ─────────────────────────────
// たいしの最優先事項「APIキーの悪用・コスト暴走・動作鈍化を絶対避ける」への3段防御:
//   ①ログイン必須（既存 Google OAuth・cookie から判定）
//   ②ユーザー日次上限（ai_usage テーブル: user_id × day × kind）
//   ③グローバル日次上限（env AI_DAILY_GLOBAL_CAP・既定300。全ユーザー合計）
// 事前準備: supabase-ai.sql を Supabase SQL Editor で1回実行（ai_usage テーブル）。

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Gemini無料枠は1プロジェクトあたり約250リクエスト/日 → 既定200で手前に防衛線
// （超えても課金はされず429で止まるだけだが、全員が使えなくなるのを防ぐ）
const GLOBAL_CAP = Number(process.env.AI_DAILY_GLOBAL_CAP ?? '200')

// JSTの日付（サーバーはUTCなので+9hで日替わりを日本時間に合わせる）
function jstDay(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
}

// service role があれば優先（グローバル上限の集計に必要）。無ければユーザー権限のRLSで自分の行のみ。
function getServiceClient(): SupabaseClient | null {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export type GuardResult =
  | { ok: true; userId: string; remaining: number }  // remaining=今回の消費後の残り回数
  | { ok: false; status: number; message: string }

// 認証＋上限チェック＋使用回数のインクリメントまで行う（通った時点で1回消費）。
export async function requireUserAndQuota(kind: 'add' | 'theme', userDailyLimit: number): Promise<GuardResult> {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) return { ok: false, status: 500, message: 'サーバー設定エラー（Supabase未設定）' }

  // ① 認証（middleware がセッション更新済み → cookie から取得できる）
  const cookieStore = cookies()
  const sbUser = createServerClient(url, anon, {
    cookies: {
      getAll() { return cookieStore.getAll() },
      setAll() { /* Route Handler では書き込まない */ },
    },
  })
  const { data: { user } } = await sbUser.auth.getUser()
  if (!user) return { ok: false, status: 401, message: 'AI機能のご利用にはログインが必要です' }

  const day = jstDay()
  const svc = getServiceClient()
  const db = svc ?? sbUser // service role が無ければユーザー権限（RLS=自分の行のみ）で動かす

  try {
    // ② ユーザー日次上限
    const { data: mine } = await db.from('ai_usage')
      .select('count').eq('user_id', user.id).eq('day', day).eq('kind', kind).maybeSingle()
    const myCount = (mine as { count: number } | null)?.count ?? 0
    if (myCount >= userDailyLimit) {
      return { ok: false, status: 429, message: `本日のAI利用上限（${userDailyLimit}回）に達しました。明日また使えます` }
    }

    // ③ グローバル日次上限（service role がある場合のみ全ユーザー合計を見られる）
    if (svc) {
      const { data: all } = await svc.from('ai_usage').select('count').eq('day', day)
      const total = ((all ?? []) as { count: number }[]).reduce((s, r) => s + (r.count ?? 0), 0)
      if (total >= GLOBAL_CAP) {
        return { ok: false, status: 429, message: '本日のAI利用が混み合っています。明日また使えます' }
      }
    }

    // カウント+1（upsert）
    await db.from('ai_usage').upsert(
      { user_id: user.id, day, kind, count: myCount + 1 },
      { onConflict: 'user_id,day,kind' },
    )
    return { ok: true, userId: user.id, remaining: Math.max(0, userDailyLimit - (myCount + 1)) }
  } catch (e) {
    // ai_usage テーブル未作成等。安全側（利用不可）に倒す＝コスト暴走を防ぐのが最優先
    console.error('[api-guard] ai_usage error:', e instanceof Error ? e.message : e)
    return { ok: false, status: 500, message: 'AI機能の準備中です（管理者: supabase-ai.sql を実行してください）' }
  }
}

// 本日の利用状況の読み取り専用（回数は消費しない）。AIアシストの「きょうの残り回数」表示用。
export async function readUsage(limits: Record<string, number>): Promise<
  { ok: true; usage: Record<string, { used: number; limit: number }> } | { ok: false; status: number }
> {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) return { ok: false, status: 500 }
  const cookieStore = cookies()
  const sbUser = createServerClient(url, anon, {
    cookies: { getAll() { return cookieStore.getAll() }, setAll() { /* noop */ } },
  })
  const { data: { user } } = await sbUser.auth.getUser()
  if (!user) return { ok: false, status: 401 }
  const usage: Record<string, { used: number; limit: number }> = {}
  for (const [kind, limit] of Object.entries(limits)) usage[kind] = { used: 0, limit }
  try {
    const { data } = await sbUser.from('ai_usage')
      .select('kind,count').eq('user_id', user.id).eq('day', jstDay())
    for (const r of (data ?? []) as { kind: string; count: number }[]) {
      if (usage[r.kind]) usage[r.kind].used = r.count ?? 0
    }
  } catch { /* テーブル未作成 → used 0 のまま */ }
  return { ok: true, usage }
}
