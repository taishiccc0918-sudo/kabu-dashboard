-- 日本株の事業内容（冒頭3行・本文）。Supabase SQL Editor で実行。
-- refresh-jp-bizdesc が Gemini で生成して保存。アプリは読み取るだけ。
create table if not exists public.jp_company_desc (
  code        text primary key,
  biz_desc    text,
  updated_at  timestamptz default now()
);
alter table public.jp_company_desc enable row level security;
drop policy if exists "JP事業内容は全員読み取り可" on public.jp_company_desc;
create policy "JP事業内容は全員読み取り可" on public.jp_company_desc for select using (true);
