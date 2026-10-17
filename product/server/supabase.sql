-- SwitchGuard shared storage on Supabase. Run once in the SQL editor of a new project.
create table if not exists public.sg_sessions (
  id text primary key check (id ~ '^[a-f0-9]{24}$'),
  json text not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
-- Only the server (service role key) reads or writes; no public access.
alter table public.sg_sessions enable row level security;
revoke all on public.sg_sessions from anon, authenticated;

insert into storage.buckets (id, name, public) values ('switchguard-media', 'switchguard-media', false)
on conflict (id) do nothing;
