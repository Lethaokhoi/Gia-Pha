-- Chạy trong Supabase → SQL Editor nếu thiếu hàm (gp_is_family_owner, gp_invite_by_email, …)
-- Run → đợi 10 giây → F5 trang web

create or replace function public.gp_is_family_member(fid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gp_family_members m
    where m.family_id = fid and m.user_id = auth.uid()
  );
$$;

create or replace function public.gp_is_family_owner(fid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gp_family_members m
    where m.family_id = fid and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

alter table public.gp_family_members
  add column if not exists user_email text;

create table if not exists public.gp_family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.gp_families (id) on delete cascade,
  email text not null,
  role text not null default 'editor',
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create unique index if not exists gp_family_invites_family_email_idx
  on public.gp_family_invites (family_id, lower(trim(email)));

grant select, insert, delete on public.gp_family_invites to authenticated;

create or replace function public.gp_list_family_access(p_family_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  members jsonb;
  invites jsonb;
begin
  if not public.gp_is_family_member(p_family_id) then
    raise exception 'Không có quyền xem';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', m.user_id, 'role', m.role,
    'email', coalesce(m.user_email, u.email),
    'joined_at', m.joined_at
  ) order by m.role desc, m.joined_at), '[]'::jsonb)
  into members
  from public.gp_family_members m
  left join auth.users u on u.id = m.user_id
  where m.family_id = p_family_id;

  if public.gp_is_family_owner(p_family_id) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'email', i.email, 'created_at', i.created_at
    ) order by i.created_at), '[]'::jsonb)
    into invites from public.gp_family_invites i where i.family_id = p_family_id;
  else
    invites := '[]'::jsonb;
  end if;

  return jsonb_build_object('members', members, 'invites', invites, 'is_owner', public.gp_is_family_owner(p_family_id));
end;
$$;

create or replace function public.gp_invite_by_email(p_family_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare norm text; inv_id uuid;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if not public.gp_is_family_owner(p_family_id) then raise exception 'Chỉ chủ gia phả'; end if;
  norm := lower(trim(p_email));
  if norm = '' or position('@' in norm) = 0 then
    raise exception 'Email không hợp lệ';
  end if;
  delete from public.gp_family_invites where family_id = p_family_id and lower(trim(email)) = norm;
  insert into public.gp_family_invites (family_id, email, invited_by)
  values (p_family_id, norm, auth.uid())
  returning id into inv_id;
  return inv_id;
end;
$$;

grant execute on function public.gp_is_family_member(uuid) to authenticated;
grant execute on function public.gp_is_family_owner(uuid) to authenticated;
grant execute on function public.gp_list_family_access(uuid) to authenticated;
grant execute on function public.gp_invite_by_email(uuid, text) to authenticated;

-- Khi người được mời đăng nhập: tự thêm vào gia phả (khớp email auth.users)
create or replace function public.gp_claim_invites()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text;
  n int := 0;
  r record;
begin
  if auth.uid() is null then return 0; end if;
  select lower(trim(email)) into norm from auth.users where id = auth.uid();
  if norm is null or norm = '' then return 0; end if;
  for r in
    select id, family_id from public.gp_family_invites
    where lower(trim(email)) = norm
  loop
    insert into public.gp_family_members (family_id, user_id, role, user_email)
    values (r.family_id, auth.uid(), 'editor', norm)
    on conflict (family_id, user_id) do update set user_email = excluded.user_email;
    delete from public.gp_family_invites where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Xem lời mời chờ (trước khi claim) — để app hiển thị gợi ý
create or replace function public.gp_peek_pending_invites()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text;
begin
  if auth.uid() is null then return '[]'::jsonb; end if;
  select lower(trim(email)) into norm from auth.users where id = auth.uid();
  if norm is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'family_id', i.family_id,
      'family_name', f.name,
      'invite_email', i.email
    ) order by i.created_at)
    from public.gp_family_invites i
    join public.gp_families f on f.id = i.family_id
    where lower(trim(i.email)) = norm
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.gp_claim_invites() to authenticated;
grant execute on function public.gp_peek_pending_invites() to authenticated;

notify pgrst, 'reload schema';
