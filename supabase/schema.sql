-- Pairly initial schema. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'สมาชิก Pairly',
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active' check (status in ('active','completed','cancelled','expired')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key(room_id,user_id)
);
create unique index if not exists one_active_room_per_user on public.room_members(user_id) where left_at is null;

create table if not exists public.room_links (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  url text not null check (url ~* '^https?://'),
  created_at timestamptz not null default now(),
  primary key(room_id,user_id)
);

create table if not exists public.match_queue (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  queued_at timestamptz not null default now()
);

create table if not exists public.room_confirmations (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key(room_id,user_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete set null,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid references public.profiles(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id,display_name,avatar_url)
  values(new.id, coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name','สมาชิก Pairly'), new.raw_user_meta_data->>'avatar_url')
  on conflict(id) do update set display_name=excluded.display_name, avatar_url=excluded.avatar_url;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- Atomic queue claim: SKIP LOCKED prevents two users claiming the same waiting member.
create or replace function public.join_match_queue()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); partner uuid; new_room uuid;
begin
  if me is null then raise exception 'ต้องเข้าสู่ระบบก่อน'; end if;
  select r.id into new_room from room_members rm join rooms r on r.id=rm.room_id
    where rm.user_id=me and rm.left_at is null and r.status='active' limit 1;
  if new_room is not null then return jsonb_build_object('status','matched','room_id',new_room); end if;
  insert into match_queue(user_id) values(me) on conflict(user_id) do nothing;
  select user_id into partner from match_queue where user_id <> me order by queued_at for update skip locked limit 1;
  if partner is null then return jsonb_build_object('status','waiting'); end if;
  delete from match_queue where user_id in (me,partner);
  insert into rooms(status) values('active') returning id into new_room;
  insert into room_members(room_id,user_id) values(new_room,me),(new_room,partner);
  return jsonb_build_object('status','matched','room_id',new_room);
end; $$;

create or replace function public.leave_match_queue()
returns void language sql security definer set search_path = public as $$
  delete from match_queue where user_id=auth.uid();
$$;

create or replace function public.confirm_room_done(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); total_confirmed int;
begin
  if me is null or not exists(select 1 from room_members where room_id=p_room_id and user_id=me and left_at is null) then raise exception 'ไม่มีสิทธิ์ในห้องนี้'; end if;
  if (select status from rooms where id=p_room_id) <> 'active' then raise exception 'ห้องนี้ไม่ได้เปิดอยู่'; end if;
  insert into room_confirmations(room_id,user_id) values(p_room_id,me) on conflict do nothing;
  select count(*) into total_confirmed from room_confirmations where room_id=p_room_id;
  if total_confirmed >= 2 then update rooms set status='completed',completed_at=now() where id=p_room_id and status='active'; end if;
  return jsonb_build_object('confirmed',true,'completed',total_confirmed>=2);
end; $$;

alter table profiles enable row level security;
alter table rooms enable row level security;
alter table room_members enable row level security;
alter table room_links enable row level security;
alter table match_queue enable row level security;
alter table room_confirmations enable row level security;
alter table reports enable row level security;

create policy "profiles visible to signed in users" on profiles for select to authenticated using (true);
create policy "users update own profile" on profiles for update to authenticated using (auth.uid()=id) with check (auth.uid()=id);
create policy "members can view own rooms" on rooms for select to authenticated using (exists(select 1 from room_members rm where rm.room_id=id and rm.user_id=auth.uid()));
create or replace function public.is_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.room_members where room_id=p_room_id and user_id=auth.uid() and left_at is null);
$$;
create policy "members can view room membership" on room_members for select to authenticated using (public.is_room_member(room_id));
create policy "members view room links" on room_links for select to authenticated using (exists(select 1 from room_members rm where rm.room_id=room_links.room_id and rm.user_id=auth.uid()));
create policy "members add own room link" on room_links for insert to authenticated with check (user_id=auth.uid() and exists(select 1 from room_members rm where rm.room_id=room_links.room_id and rm.user_id=auth.uid() and rm.left_at is null));
create policy "members update own room link" on room_links for update to authenticated using (user_id=auth.uid() and exists(select 1 from room_members rm where rm.room_id=room_links.room_id and rm.user_id=auth.uid() and rm.left_at is null)) with check (user_id=auth.uid());
create policy "users see own queue entry" on match_queue for select to authenticated using (user_id=auth.uid());
create policy "members view confirmations in own room" on room_confirmations for select to authenticated using (exists(select 1 from room_members rm where rm.room_id=room_confirmations.room_id and rm.user_id=auth.uid()));
create policy "users create reports" on reports for insert to authenticated with check (reporter_id=auth.uid());

revoke all on function public.join_match_queue() from public;
revoke all on function public.leave_match_queue() from public;
revoke all on function public.confirm_room_done(uuid) from public;
grant execute on function public.join_match_queue() to authenticated;
grant execute on function public.leave_match_queue() to authenticated;
grant execute on function public.confirm_room_done(uuid) to authenticated;

-- Enable realtime events for room updates (safe to re-run).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='room_links') then alter publication supabase_realtime add table public.room_links; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='room_confirmations') then alter publication supabase_realtime add table public.room_confirmations; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rooms') then alter publication supabase_realtime add table public.rooms; end if;
end $$;
