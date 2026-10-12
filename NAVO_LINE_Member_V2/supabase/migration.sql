-- NAVO LINE 會員端：資料表與一次性驗證碼綁定函式
-- 不修改既有 customers / purchases / trips 資料。
create table if not exists public.navo_line_bind_codes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  code_hash text not null unique,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_line_user_id text
);

create index if not exists navo_line_bind_codes_customer_idx on public.navo_line_bind_codes(customer_id);

create table if not exists public.navo_line_members (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid unique references public.customers(id) on delete cascade,
  line_user_id text not null unique,
  display_name text,
  bound_at timestamptz not null default now()
);

-- Safe upgrade for projects where the first version of this table already exists:
-- LINE users can self-register before they have a CRM customer record.
alter table public.navo_line_members alter column customer_id drop not null;
alter table public.navo_line_members add column if not exists display_name text;

create table if not exists public.navo_vip_coupons (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  title text not null,
  amount numeric(10,2) not null default 0 check (amount >= 0),
  minimum_spend numeric(10,2) not null default 0 check (minimum_spend >= 0),
  status text not null default 'active' check (status in ('active','used','expired','cancelled')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  used_at timestamptz,
  note text
);
create index if not exists navo_vip_coupons_customer_idx on public.navo_vip_coupons(customer_id, status, expires_at);

alter table public.navo_line_bind_codes enable row level security;
alter table public.navo_line_members enable row level security;
alter table public.navo_vip_coupons enable row level security;

-- 這些資料只由 Edge Function 使用 service-role 存取，前端不可直接讀寫。
revoke all on public.navo_line_bind_codes from anon, authenticated;
revoke all on public.navo_line_members from anon, authenticated;
revoke all on public.navo_vip_coupons from anon, authenticated;
grant all on public.navo_line_bind_codes to service_role;
grant all on public.navo_line_members to service_role;
grant all on public.navo_vip_coupons to service_role;

create or replace function public.navo_bind_line_member(p_code_hash text, p_line_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.navo_line_bind_codes%rowtype;
begin
  select * into v_code
  from public.navo_line_bind_codes
  where code_hash = p_code_hash
    and used_at is null
    and expires_at > now()
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'message', '驗證碼無效、已使用或已過期。請向 NAVO 重新取得驗證碼。');
  end if;

  if exists (select 1 from public.navo_line_members where customer_id = v_code.customer_id) then
    return jsonb_build_object('ok', false, 'message', '這個 NAVO 會員已綁定 LINE。請聯絡 NAVO 協助處理。');
  end if;

  if exists (select 1 from public.navo_line_members where line_user_id = p_line_user_id and customer_id is not null) then
    return jsonb_build_object('ok', false, 'message', '這個 LINE 帳號已綁定其他會員。請聯絡 NAVO 協助處理。');
  end if;

  -- Upgrade an auto-registered LINE account in place, or create a binding if needed.
  update public.navo_line_members
  set customer_id = v_code.customer_id, bound_at = now()
  where line_user_id = p_line_user_id and customer_id is null;

  if not found then
    insert into public.navo_line_members(customer_id, line_user_id)
    values (v_code.customer_id, p_line_user_id);
  end if;

  update public.navo_line_bind_codes
  set used_at = now(), used_line_user_id = p_line_user_id
  where id = v_code.id;

  return jsonb_build_object('ok', true, 'customer_id', v_code.customer_id);
end;
$$;

revoke all on function public.navo_bind_line_member(text, text) from public, anon, authenticated;
grant execute on function public.navo_bind_line_member(text, text) to service_role;
