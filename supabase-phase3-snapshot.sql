-- ============================================================
-- kabu-dashboard Phase3: 事前計算スナップショット
-- Supabase ダッシュボード → SQL Editor で実行してください
-- （毎日GitHub Actionsが裏で計算してここに保存。ブラウザは読むだけ＝0秒表示）
-- ============================================================

create table if not exists public.stock_snapshot (
  code        text primary key,
  price       jsonb,          -- PriceRecord（close, chg*, prev1m, mcap など）
  fin         jsonb,          -- FinRecord（eps, feps, per, roe, fyEps など）
  per_band    jsonb,          -- PerBand（highPER, lowPER, position, reason）
  biz_date    text,           -- 基準営業日（YYYY-MM-DD）
  updated_at  timestamptz default now()
);

-- 全体の更新メタ（最終更新時刻・基準日・銘柄数）を1行で持つ
create table if not exists public.snapshot_meta (
  id          int primary key default 1,
  biz_date    text,
  count       int,
  updated_at  timestamptz default now()
);

alter table public.stock_snapshot enable row level security;
alter table public.snapshot_meta enable row level security;

-- 誰でも読み取り可（市場データなので公開・匿名キーで読める）。書き込みはservice_roleのみ（RLSをバイパス）
drop policy if exists "スナップショットは全員読み取り可" on public.stock_snapshot;
create policy "スナップショットは全員読み取り可"
  on public.stock_snapshot for select using (true);

drop policy if exists "メタは全員読み取り可" on public.snapshot_meta;
create policy "メタは全員読み取り可"
  on public.snapshot_meta for select using (true);
