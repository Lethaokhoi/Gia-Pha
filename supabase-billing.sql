-- Gói gia phả: miễn phí tối đa 30 thành viên, 20.000đ / gia phả → không giới hạn
-- Supabase → SQL Editor → Run

alter table public.gp_families
  add column if not exists max_members int not null default 30;

alter table public.gp_families
  add column if not exists is_unlimited boolean not null default false;

-- Hàm phụ thuộc (cần có trước gp_get_family_billing / gp_create_premium_order)
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

create table if not exists public.gp_premium_orders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.gp_families (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  payment_code text not null unique,
  amount_vnd int not null default 20000,
  status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists gp_premium_orders_family_idx on public.gp_premium_orders (family_id);

alter table public.gp_premium_orders enable row level security;

drop policy if exists "gp_orders_select" on public.gp_premium_orders;
create policy "gp_orders_select" on public.gp_premium_orders
  for select using (owner_id = auth.uid());

create or replace function public.gp_family_member_count(p_data jsonb)
returns int
language sql
immutable
as $$
  select coalesce(jsonb_array_length(p_data -> 'members'), 0);
$$;

create or replace function public.gp_enforce_member_limit()
returns trigger
language plpgsql
as $$
declare
  n int;
begin
  if coalesce(NEW.is_unlimited, false) then
    return NEW;
  end if;
  n := public.gp_family_member_count(NEW.data);
  if n > coalesce(NEW.max_members, 30) then
    raise exception 'Gia phả miễn phí tối đa % thành viên. Nâng cấp 20.000đ để không giới hạn.', coalesce(NEW.max_members, 30);
  end if;
  return NEW;
end;
$$;

drop trigger if exists gp_families_member_limit on public.gp_families;
create trigger gp_families_member_limit
  before insert or update of data, is_unlimited, max_members on public.gp_families
  for each row execute function public.gp_enforce_member_limit();

create or replace function public.gp_get_family_billing(p_family_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  fam record;
  pending_code text;
  cnt int;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if not public.gp_is_family_member(p_family_id) then
    raise exception 'Không có quyền';
  end if;

  select id, name, max_members, is_unlimited, data
  into fam
  from public.gp_families
  where id = p_family_id;

  cnt := public.gp_family_member_count(fam.data);

  select payment_code into pending_code
  from public.gp_premium_orders
  where family_id = p_family_id and status = 'pending'
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'member_count', cnt,
    'max_members', fam.max_members,
    'is_unlimited', coalesce(fam.is_unlimited, false),
    'can_add_more', coalesce(fam.is_unlimited, false) or cnt < fam.max_members,
    'premium_price_vnd', 20000,
    'pending_payment_code', pending_code,
    'is_owner', public.gp_is_family_owner(p_family_id)
  );
end;
$$;

create or replace function public.gp_create_premium_order(p_family_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  code text;
  oid uuid;
begin
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  if not public.gp_is_family_owner(p_family_id) then
    raise exception 'Chỉ chủ gia phả mới nâng cấp';
  end if;
  if exists (select 1 from public.gp_families where id = p_family_id and is_unlimited) then
    raise exception 'Gia phả đã không giới hạn thành viên';
  end if;

  update public.gp_premium_orders
  set status = 'cancelled'
  where family_id = p_family_id and status = 'pending';

  code := 'GP' || upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 8));

  insert into public.gp_premium_orders (family_id, owner_id, payment_code, amount_vnd)
  values (p_family_id, auth.uid(), code, 20000)
  returning id into oid;

  return jsonb_build_object(
    'order_id', oid,
    'payment_code', code,
    'amount_vnd', 20000
  );
end;
$$;

-- Xác nhận thanh toán (chạy thủ công sau khi nhận chuyển khoản, hoặc gọi từ webhook SePay/PayOS)
create or replace function public.gp_confirm_premium_order(p_payment_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ord record;
begin
  select * into ord
  from public.gp_premium_orders
  where upper(trim(payment_code)) = upper(trim(p_payment_code)) and status = 'pending'
  limit 1;

  if ord.id is null then
    raise exception 'Không tìm thấy đơn chờ với mã %', p_payment_code;
  end if;

  update public.gp_premium_orders
  set status = 'paid', paid_at = now()
  where id = ord.id;

  update public.gp_families
  set is_unlimited = true
  where id = ord.family_id;

  return jsonb_build_object('ok', true, 'family_id', ord.family_id);
end;
$$;

grant execute on function public.gp_get_family_billing(uuid) to authenticated;
grant execute on function public.gp_create_premium_order(uuid) to authenticated;
grant execute on function public.gp_confirm_premium_order(text) to authenticated;

notify pgrst, 'reload schema';
