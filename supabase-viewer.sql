-- Chạy trong Supabase → SQL Editor (sau các script gp_* khác)
-- Viewer: chỉ xem. Link công khai: view.html?code=MÃ_MỜI

-- Cho phép role viewer trên thành viên gia phả
alter table public.gp_family_members drop constraint if exists gp_family_members_role_check;
alter table public.gp_family_members
  add constraint gp_family_members_role_check check (role in ('owner', 'editor', 'viewer'));

alter table public.gp_family_invites drop constraint if exists gp_family_invites_role_check;
alter table public.gp_family_invites
  add constraint gp_family_invites_role_check check (role in ('editor', 'viewer'));

create or replace function public.gp_can_edit_family(fid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gp_family_members m
    where m.family_id = fid
      and m.user_id = auth.uid()
      and m.role in ('owner', 'editor')
  );
$$;

drop policy if exists "gp_families_update" on public.gp_families;
create policy "gp_families_update" on public.gp_families
  for update to authenticated
  using (public.gp_can_edit_family(id));

-- Tham gia bằng mã (editor hoặc viewer)
create or replace function public.gp_join_by_invite(p_code text, p_role text default 'editor')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  r text;
begin
  if auth.uid() is null then
    raise exception 'Cần đăng nhập';
  end if;
  r := lower(trim(coalesce(p_role, 'editor')));
  if r not in ('editor', 'viewer') then
    r := 'editor';
  end if;
  select id into fid
  from public.gp_families
  where invite_code = upper(trim(p_code))
  limit 1;
  if fid is null then
    raise exception 'Mã mời không đúng';
  end if;
  insert into public.gp_family_members (family_id, user_id, role)
  values (fid, auth.uid(), r)
  on conflict (family_id, user_id) do update set role = excluded.role;
  return fid;
end;
$$;

grant execute on function public.gp_join_by_invite(text, text) to authenticated;
grant execute on function public.gp_join_by_invite(text) to authenticated;

-- Xem công khai không cần đăng nhập (chỉ đọc qua mã)
create or replace function public.gp_public_family_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select f.name, f.data, f.invite_code into r
  from public.gp_families f
  where f.invite_code = upper(trim(p_code))
  limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'name', r.name,
    'data', r.data,
    'invite_code', r.invite_code
  );
end;
$$;

grant execute on function public.gp_public_family_by_code(text) to anon, authenticated;

-- Mã mời + link (chỉ chủ)
create or replace function public.gp_get_family_share_info(p_family_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if not public.gp_is_family_owner(p_family_id) then
    raise exception 'Chỉ chủ gia phả';
  end if;
  select name, invite_code into r from public.gp_families where id = p_family_id;
  if not found then return null; end if;
  return jsonb_build_object('name', r.name, 'invite_code', r.invite_code);
end;
$$;

grant execute on function public.gp_get_family_share_info(uuid) to authenticated;

-- Mời email kèm quyền editor | viewer
create or replace function public.gp_invite_by_email(
  p_family_id uuid,
  p_email text,
  p_role text default 'editor'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text;
  inv_id uuid;
  r text;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if not public.gp_is_family_owner(p_family_id) then raise exception 'Chỉ chủ gia phả'; end if;
  norm := lower(trim(p_email));
  if norm = '' then raise exception 'Thiếu email'; end if;
  r := lower(trim(coalesce(p_role, 'editor')));
  if r not in ('editor', 'viewer') then r := 'editor'; end if;
  delete from public.gp_family_invites where family_id = p_family_id and lower(trim(email)) = norm;
  insert into public.gp_family_invites (family_id, email, role, invited_by)
  values (p_family_id, norm, r, auth.uid())
  returning id into inv_id;
  return inv_id;
end;
$$;

grant execute on function public.gp_invite_by_email(uuid, text, text) to authenticated;
grant execute on function public.gp_invite_by_email(uuid, text) to authenticated;

-- Nhận lời mời theo đúng role trong bảng invites
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
  inv_role text;
begin
  if auth.uid() is null then return 0; end if;
  select lower(trim(email)) into norm from auth.users where id = auth.uid();
  if norm is null or norm = '' then return 0; end if;
  for r in
    select id, family_id, role from public.gp_family_invites where lower(trim(email)) = norm
  loop
    inv_role := lower(trim(coalesce(r.role, 'editor')));
    if inv_role not in ('editor', 'viewer') then inv_role := 'editor'; end if;
    insert into public.gp_family_members (family_id, user_id, role, user_email)
    values (r.family_id, auth.uid(), inv_role, norm)
    on conflict (family_id, user_id) do update
      set role = excluded.role, user_email = excluded.user_email;
    delete from public.gp_family_invites where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

grant execute on function public.gp_claim_invites() to authenticated;

-- Hiển thị quyền trong hộp Chia sẻ
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
      'id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at
    ) order by i.created_at), '[]'::jsonb)
    into invites from public.gp_family_invites i where i.family_id = p_family_id;
  else
    invites := '[]'::jsonb;
  end if;

  return jsonb_build_object('members', members, 'invites', invites, 'is_owner', public.gp_is_family_owner(p_family_id));
end;
$$;

grant execute on function public.gp_list_family_access(uuid) to authenticated;
