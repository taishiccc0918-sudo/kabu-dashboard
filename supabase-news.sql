-- ============================================================
-- kabu-dashboard ニュース蓄積テーブル
-- Supabase ダッシュボード → SQL Editor で1回だけ実行してください。
-- GitHub Actions が定期的に各お気に入り銘柄のニュースを収集し、ここに追記（差分蓄積）します。
-- ブラウザ（ニュースタブ）はここを読むだけ＝初回から即表示・全件・軽い。
-- ============================================================

create table if not exists public.stock_news (
  link        text primary key,      -- 記事URL（重複排除キー）
  code        text not null,         -- 銘柄コード
  name        text,                  -- 銘柄名
  title       text not null,         -- 記事タイトル
  source      text,                  -- 媒体名
  source_url  text,                  -- 媒体ドメイン（favicon用）
  pub_date    timestamptz,           -- 記事公開日時
  ir          boolean default false, -- 企業公式サイト発
  disc        boolean default false, -- 決算・適時開示
  fetched_at  timestamptz default now()
);

create index if not exists stock_news_pub_date_idx on public.stock_news (pub_date desc);
create index if not exists stock_news_code_idx on public.stock_news (code);

alter table public.stock_news enable row level security;

-- 誰でも読み取り可（市場ニュースなので公開・匿名キーで読める）。書き込みはservice_roleのみ（RLSバイパス）。
drop policy if exists "ニュースは全員読み取り可" on public.stock_news;
create policy "ニュースは全員読み取り可"
  on public.stock_news for select using (true);
