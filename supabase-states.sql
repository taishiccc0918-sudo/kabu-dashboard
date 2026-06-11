-- ============================================================
-- 銘柄ステータス（気になる→ウォッチ中→買いたい→保有→売却済み）
-- 銘柄ごとの「いまの状態」＋目標価格＋買いたい理由（1銘柄1行）。
-- ステータス変更の履歴は stock_notes（kind='status_change'）に積まれる。
-- Supabase ダッシュボード → SQL Editor で1回だけ実行してください（冪等）。
-- ============================================================

create table if not exists public.stock_states (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  code              text not null,
  status            text not null default 'watching'
                    check (status in ('interested','watching','want_to_buy','holding','sold','archived')),
  target_price      numeric,            -- 「いくらなら買いたい」
  buy_reason        text not null default '',  -- なぜこの銘柄か（一言）
  status_changed_at timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (user_id, code)
);

alter table public.stock_states enable row level security;

drop policy if exists "自分のステータスのみ操作可" on public.stock_states;
create policy "自分のステータスのみ操作可"
  on public.stock_states for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
