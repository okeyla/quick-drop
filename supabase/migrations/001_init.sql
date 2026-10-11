-- QuickDrop：暫存檔案中轉。所有存取都經過 Edge Function（service role），
-- 所以資料表開啟 RLS 且不建立任何 policy，瀏覽器無法直接讀寫。

create table public.drops (
  id text primary key,                              -- 取件碼
  delete_after_download boolean not null default true,
  ready boolean not null default false,             -- 上傳完成後才可取件
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.drop_files (
  id uuid primary key default gen_random_uuid(),
  drop_id text not null references public.drops(id) on delete cascade,
  name text not null,
  size bigint not null,
  path text not null
);
create index drop_files_drop_id_idx on public.drop_files(drop_id);

-- upload_password_sha256：共用上傳密碼的 SHA-256（十六進位）
create table public.config (
  key text primary key,
  value text not null
);

alter table public.drops enable row level security;
alter table public.drop_files enable row level security;
alter table public.config enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values ('drops', 'drops', false, 52428800);
