-- ============================================================
-- SỬA LỖI "violates row-level security" KHI TẠO GIA PHẢ
-- Supabase Dashboard → SQL Editor → dán TOÀN BỘ file → Run
-- ============================================================

alter table public.gp_family_members
  add column if not exists user_email text;

grant usage on schema public to authenticated;
grant select, insert, update on public.gp_families to authenticated;
grant select, insert, update, delete on public.gp_family_members to authenticated;

drop policy if exists "gp_families_insert" on public.gp_families;
create policy "gp_families_insert" on public.gp_families
  for insert to authenticated
  with check (auth.uid() = owner_id);

drop policy if exists "gp_families_select" on public.gp_families;
create policy "gp_families_select" on public.gp_families
  for select to authenticated
  using (public.gp_is_family_member(id));

drop policy if exists "gp_families_update" on public.gp_families;
create policy "gp_families_update" on public.gp_families
  for update to authenticated
  using (public.gp_is_family_member(id));

create or replace function public.gp_create_family(
  p_name text,
  p_invite_code text,
  p_data jsonb default '{"members":[],"focalId":null,"treeScope":"ca_hai"}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  v_name text;
  v_code text;
  v_updated timestamptz;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Chưa đăng nhập hoặc sai API key (cần anon key eyJ... trong config.js)';
  end if;

  v_name := coalesce(nullif(trim(p_name), ''), 'Gia phả');
  v_code := upper(trim(p_invite_code));

  insert into public.gp_families (name, invite_code, owner_id, data, updated_by)
  values (
    v_name,
    v_code,
    auth.uid(),
    coalesce(p_data, '{"members":[],"focalId":null,"treeScope":"ca_hai"}'::jsonb),
    auth.uid()
  )
  returning id, updated_at into fid, v_updated;

  select lower(email) into v_email from auth.users where id = auth.uid();

  insert into public.gp_family_members (family_id, user_id, role, user_email)
  values (fid, auth.uid(), 'owner', v_email)
  on conflict (family_id, user_id) do update
    set role = 'owner', user_email = coalesce(excluded.user_email, gp_family_members.user_email);

  return jsonb_build_object(
    'id', fid,
    'name', v_name,
    'invite_code', v_code,
    'updated_at', v_updated
  );
end;
$$;

grant execute on function public.gp_create_family(text, text, jsonb) to authenticated;

-- === Chia sẻ / «Người đang sửa chung» / mời email ===

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

create table if not exists public.gp_family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.gp_families (id) on delete cascade,
  email text not null,
  role text not null default 'editor' check (role in ('editor')),
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create unique index if not exists gp_family_invites_family_email_idx
  on public.gp_family_invites (family_id, lower(trim(email)));

alter table public.gp_family_invites enable row level security;

grant select, insert, delete on public.gp_family_invites to authenticated;

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

create or replace function public.gp_invite_by_email(p_family_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text;
  inv_id uuid;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if not public.gp_is_family_owner(p_family_id) then raise exception 'Chỉ chủ gia phả mới mời được'; end if;
  norm := lower(trim(p_email));
  if norm = '' or position('@' in norm) < 2 then raise exception 'Email không hợp lệ'; end if;
  delete from public.gp_family_invites
  where family_id = p_family_id and lower(trim(email)) = norm;
  insert into public.gp_family_invites (family_id, email, invited_by)
  values (p_family_id, norm, auth.uid())
  returning id into inv_id;
  return inv_id;
end;
$$;

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
  select lower(email) into norm from auth.users where id = auth.uid();
  if norm is null then return 0; end if;
  for r in select id, family_id from public.gp_family_invites where lower(trim(email)) = norm
  loop
    insert into public.gp_family_members (family_id, user_id, role, user_email)
    values (r.family_id, auth.uid(), 'editor', norm)
    on conflict (family_id, user_id) do nothing;
    delete from public.gp_family_invites where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

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
    'user_id', m.user_id,
    'role', m.role,
    'email', coalesce(m.user_email, u.email),
    'joined_at', m.joined_at
  ) order by m.role desc, m.joined_at), '[]'::jsonb)
  into members
  from public.gp_family_members m
  left join auth.users u on u.id = m.user_id
  where m.family_id = p_family_id;

  if public.gp_is_family_owner(p_family_id) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id,
      'email', i.email,
      'created_at', i.created_at
    ) order by i.created_at), '[]'::jsonb)
    into invites
    from public.gp_family_invites i
    where i.family_id = p_family_id;
  else
    invites := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'members', members,
    'invites', invites,
    'is_owner', public.gp_is_family_owner(p_family_id)
  );
end;
$$;

create or replace function public.gp_remove_family_member(p_family_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.gp_is_family_owner(p_family_id) then raise exception 'Chỉ chủ gia phả'; end if;
  if p_user_id = auth.uid() then raise exception 'Không thể gỡ chính mình'; end if;
  delete from public.gp_family_members
  where family_id = p_family_id and user_id = p_user_id and role <> 'owner';
end;
$$;

create or replace function public.gp_revoke_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare fid uuid;
begin
  select family_id into fid from public.gp_family_invites where id = p_invite_id;
  if fid is null then return; end if;
  if not public.gp_is_family_owner(fid) then raise exception 'Chỉ chủ gia phả'; end if;
  delete from public.gp_family_invites where id = p_invite_id;
end;
$$;

grant execute on function public.gp_invite_by_email(uuid, text) to authenticated;
grant execute on function public.gp_claim_invites() to authenticated;
grant execute on function public.gp_list_family_access(uuid) to authenticated;
grant execute on function public.gp_remove_family_member(uuid, uuid) to authenticated;
grant execute on function public.gp_revoke_invite(uuid) to authenticated;

notify pgrst, 'reload schema';
