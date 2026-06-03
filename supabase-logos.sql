-- 企業ロゴ・マスター（全上場企業）
-- code → ロゴURL。cron（refresh-logos）が Wikidata/Clearbit から収集して upsert する。
-- 公開read・service_role書込（既存の news/snapshot と同方針）。
-- たいしの一度だけの作業: Supabase SQL Editor でこのSQLを実行 → Actions で refresh-logos を1回実行。

create table if not exists company_logo (
  code        text primary key,
  logo_url    text,
  source      text,                 -- 'wikidata' | 'clearbit'
  updated_at  timestamptz default now()
);

alter table company_logo enable row level security;

-- 公開read（匿名キーで誰でも読める＝アプリ表示用）
drop policy if exists "public read company_logo" on company_logo;
create policy "public read company_logo" on company_logo for select using (true);

-- 書き込みは service_role（RLSを自動バイパス）。明示ポリシーは不要。
