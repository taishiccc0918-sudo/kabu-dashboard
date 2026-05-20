-- ============================================================
-- kabu-dashboard Supabase スキーマ
-- Supabase ダッシュボード → SQL Editor で実行してください
-- ============================================================

-- ── 1. プロフィールテーブル（auth.users と 1:1）────────────────
create table public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  email         text,
  display_name  text,
  is_admin      boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "自分のプロフィールのみ読み取り可"
  on public.profiles for select using (auth.uid() = id);
create policy "自分のプロフィールのみ更新可"
  on public.profiles for update using (auth.uid() = id);

-- ── 2. お気に入りテーブル（★=star / ♥=heart）────────────────
create table public.favorites (
  user_id    uuid references public.profiles(id) on delete cascade,
  code       text not null,
  type       text not null check (type in ('star', 'heart')),
  created_at timestamptz default now(),
  primary key (user_id, code, type)
);

alter table public.favorites enable row level security;

create policy "自分のお気に入りのみ操作可"
  on public.favorites for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 3. メモテーブル ────────────────────────────────────────────
create table public.memos (
  user_id    uuid references public.profiles(id) on delete cascade,
  code       text not null,
  memo       text not null default '',
  updated_at timestamptz default now(),
  primary key (user_id, code)
);

alter table public.memos enable row level security;

create policy "自分のメモのみ操作可"
  on public.memos for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 4. 新規ユーザー登録時にプロフィール自動作成 ─────────────────
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email)
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
