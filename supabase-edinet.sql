-- ============================================================
-- kabu-dashboard 企業ファクトシート蓄積テーブル（EDINET 有価証券報告書 由来）
-- Supabase ダッシュボード → SQL Editor で1回だけ実行してください。
-- GitHub Actions（月次）が各お気に入り銘柄の最新「有価証券報告書」を EDINET API から取得し、
-- 機械抽出した会社概要（事業内容/代表者/設立/従業員数/セグメント別売上）をここに追記します。
-- ブラウザ（詳細パネルの「企業ファクトシート」）はここを読むだけ＝即表示・軽い。
--
-- 【捏造ゼロの原則】格納される値は EDINET 一次情報からの機械抽出のみ。
--   取得できなかった項目は NULL（フロントで「データなし」と明示）。推測値は一切入れない。
-- ============================================================

create table if not exists public.company_factsheet (
  code            text primary key,      -- 証券コード（4桁）
  edinet_code     text,                  -- EDINETコード（E+5桁）
  biz_desc        text,                  -- 事業内容（有報原文の抜粋）
  ceo             text,                  -- 代表者（原文由来）
  founded         text,                  -- 設立/創業（原文由来）
  employees       integer,               -- 連結従業員数（NumberOfEmployees）
  employees_as_of text,                  -- 従業員数の基準日（原文由来）
  segments        jsonb,                 -- セグメント別売上 [{name, sales}]（機械抽出）
  doc_url         text,                  -- 出典: EDINET該当書類のビューアURL
  doc_date        text,                  -- 有報の提出日
  doc_id          text,                  -- EDINET書類管理番号（docID。差分判定用）
  fetched_at      timestamptz default now()
);

alter table public.company_factsheet enable row level security;

-- 誰でも読み取り可（公開情報のため。匿名キーで読める）。書き込みはservice_roleのみ（RLSバイパス）。
drop policy if exists "ファクトシートは全員読み取り可" on public.company_factsheet;
create policy "ファクトシートは全員読み取り可"
  on public.company_factsheet for select using (true);
