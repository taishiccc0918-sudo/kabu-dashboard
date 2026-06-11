-- ── AIアシスト（自然文一括登録・テーマ検索）の利用回数テーブル ──────────
-- 目的: Gemini API のコスト暴走防止（ユーザー日次上限＋グローバル日次上限の台帳）。
-- 実行: Supabase SQL Editor に貼り付けて1回実行（冪等・既存があっても安全）。

create table if not exists public.ai_usage (
  user_id uuid not null,
  day     date not null,
  kind    text not null,          -- 'add'（自然文一括登録） / 'theme'（テーマ検索）
  count   int  not null default 0,
  primary key (user_id, day, kind)
);

alter table public.ai_usage enable row level security;

-- 本人は自分の行を読める（残回数の表示用・任意）
drop policy if exists "ai_usage select own" on public.ai_usage;
create policy "ai_usage select own" on public.ai_usage
  for select using (auth.uid() = user_id);

-- 本人は自分の行を作成/更新できる（APIルートがユーザー権限で動く場合のフォールバック。
-- SUPABASE_SERVICE_ROLE_KEY を Vercel に設定済みなら service role 経由で書くため実質未使用）
drop policy if exists "ai_usage insert own" on public.ai_usage;
create policy "ai_usage insert own" on public.ai_usage
  for insert with check (auth.uid() = user_id);

drop policy if exists "ai_usage update own" on public.ai_usage;
create policy "ai_usage update own" on public.ai_usage
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
