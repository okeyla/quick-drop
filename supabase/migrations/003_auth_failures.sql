-- 密碼輸入錯誤的紀錄，用來限制同一 IP 的嘗試次數
create table public.auth_failures (
  id bigint generated always as identity primary key,
  ip text not null,
  at timestamptz not null default now()
);
create index auth_failures_ip_at_idx on public.auth_failures(ip, at);
alter table public.auth_failures enable row level security;
