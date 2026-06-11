-- ============================================================
-- 銘柄ノート（タイムライン型・追記式）テーブル
-- 「上書きメモ」とは別に、日付つきの記録を積み重ねる正本。
-- 保存時の株価・PER等のスナップショットを自動添付し、
-- 「当時いくらのときに自分は何を考えたか」が永久に残る。
-- Supabase ダッシュボード → SQL Editor で1回だけ実行してください（冪等）。
-- ============================================================

create table if not exists public.stock_notes (
  id         text primary key,            -- クライアント生成（uuid または legacy-<code>）
  user_id    uuid not null references public.profiles(id) on delete cascade,
  code       text not null,               -- 銘柄コード（日本株 '7203' / 米国株 'AAPL'）
  market     text not null default 'jp',  -- 'jp' | 'us'
  kind       text not null default 'note'
             check (kind in ('note','status_change','target','trade','review')),
  body       text not null default '',
  snapshot   jsonb not null default '{}'::jsonb,  -- {"price":1840,"per":12.3,"pbr":1.1,"divY":0.032,"mcap":...}
  meta       jsonb not null default '{}'::jsonb,  -- kind別の付帯情報（trade: {"side":"buy","price":...} 等）
  created_at timestamptz not null default now()
);

create index if not exists stock_notes_user_code_idx
  on public.stock_notes (user_id, code, created_at desc);
create index if not exists stock_notes_user_time_idx
  on public.stock_notes (user_id, created_at desc);

alter table public.stock_notes enable row level security;

drop policy if exists "自分のノートのみ操作可" on public.stock_notes;
create policy "自分のノートのみ操作可"
  on public.stock_notes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
