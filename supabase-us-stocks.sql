-- ============================================================
-- kabu-dashboard 米国株（US stocks）対応スキーマ
-- Supabase ダッシュボード → SQL Editor で実行してください
--
-- 設計方針:
--   ・日本株(stock_snapshot 等)とは別テーブルにして既存を一切壊さない。
--   ・us_master       … 全米上場の「米国版・四季報」マスター（ティッカー/社名/取引所等）。無料(SEC)。
--   ・us_stock_snapshot… 深掘り指標（上位~300社 ∪ お気に入り）。日本株と同じ price/fin/per_band 構造。
--   ・お気に入り(favorites)・メモ(memos)は新テーブルを作らず、既存テーブルに
--     コード接頭辞 'US:'（例 'US:AAPL'）で同居させる（マイグレーション不要）。
-- ============================================================

-- 全米上場マスター（~10,000社）。SEC company_tickers_exchange.json 由来。
create table if not exists public.us_master (
  ticker      text primary key,   -- 正規ティッカー（SEC表記。例 'AAPL', 'BRK-B'）
  name        text,               -- 企業名
  exchange    text,               -- 取引所（'NASDAQ' / 'NYSE' / 'NYSE American' など）
  cik         text,               -- SEC CIK（10桁ゼロ埋め）
  sic         text,               -- SIC業種コード（深掘り層のみ。無ければnull）
  sic_label   text,               -- SIC業種名（"何の会社か"。深掘り層のみ）
  mcap        numeric,            -- 時価総額（USD百万。算出できた銘柄のみ。無ければnull）
  updated_at  timestamptz default now()
);

-- 深掘りスナップショット（日本株 stock_snapshot と同じ JSONB 構造で再利用）
create table if not exists public.us_stock_snapshot (
  ticker      text primary key,   -- 正規ティッカー
  price       jsonb,              -- PriceRecord（close, chg*, prev1m, mcap など。mcapはUSD百万）
  fin         jsonb,              -- FinRecord（eps, feps, roe, fyEps など。予想系はnull可）
  per_band    jsonb,              -- PerBand（highPER, lowPER, position, reason）
  biz_date    text,               -- 基準営業日（YYYY-MM-DD）
  updated_at  timestamptz default now()
);

-- 更新メタ（最終更新時刻・基準日・銘柄数）を1行で持つ
create table if not exists public.us_snapshot_meta (
  id          int primary key default 1,
  biz_date    text,
  count       int,
  updated_at  timestamptz default now()
);

alter table public.us_master         enable row level security;
alter table public.us_stock_snapshot enable row level security;
alter table public.us_snapshot_meta  enable row level security;

-- 市場データなので誰でも読み取り可（匿名キー）。書き込みは service_role のみ（RLSバイパス）。
drop policy if exists "USマスターは全員読み取り可" on public.us_master;
create policy "USマスターは全員読み取り可" on public.us_master for select using (true);

drop policy if exists "USスナップショットは全員読み取り可" on public.us_stock_snapshot;
create policy "USスナップショットは全員読み取り可" on public.us_stock_snapshot for select using (true);

drop policy if exists "USメタは全員読み取り可" on public.us_snapshot_meta;
create policy "USメタは全員読み取り可" on public.us_snapshot_meta for select using (true);
