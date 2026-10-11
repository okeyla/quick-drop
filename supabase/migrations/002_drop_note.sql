-- 每批上傳可以加一段備註，顯示在上傳紀錄清單
alter table public.drops add column note text not null default '';
