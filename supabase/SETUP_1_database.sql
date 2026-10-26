-- ============================================================================
-- 에브리해빗 광고 성과 콘솔 — DB 전체 셋업 (새 Supabase 프로젝트에서 1회 실행)
--
--  · SQL Editor 를 Ctrl+A → Delete 로 비운 뒤 이 파일 전체를 붙여넣고 Run.
--  · 여러 번 실행해도 안전합니다 (있으면 건너뛰거나 덮어씀, 데이터는 지우지 않음).
--  · 구조: 매체(SA / GFA) → 캠페인 → 세트(광고그룹) → 소재, 날짜별 성과
--  · 모든 날짜는 한국 시간 기준 date 로 저장합니다.
--  · 비율 지표(CTR, CPC, ROAS)는 항상 "합산 후 계산"합니다. 평균의 평균 금지.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. 사용자 / 권한
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('admin', 'viewer');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  role        public.user_role not null default 'viewer',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 계정을 만들면 자동으로 viewer 프로필이 생긴다. (관리자는 SQL 로 role 변경)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------------------------------------------------------------------------
-- 2. 광고 계정 (이 프로젝트는 에브리해빗 한 계정만 사용)
-- ---------------------------------------------------------------------------
create table if not exists public.ad_accounts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  platform     text not null default 'naver',
  customer_id  text,
  account_id   text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

insert into public.ad_accounts (name)
select '에브리해빗'
where not exists (select 1 from public.ad_accounts);

-- ---------------------------------------------------------------------------
-- 3. 이름표 (캠페인 / 세트 / 소재) — 성과 테이블에는 ID 만 두고 이름은 여기서 붙인다
--    media: 'sa' = 네이버 검색광고(API), 'gfa' = 네이버 GFA(RAW 업로드)
-- ---------------------------------------------------------------------------
create table if not exists public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  ad_account_id  uuid not null references public.ad_accounts (id) on delete cascade,
  media          text not null check (media in ('sa', 'gfa')),
  campaign_id    text not null,
  name           text,
  campaign_type  text,           -- SA: 01=파워링크, 02=쇼핑검색, 04=브랜드검색 …
  updated_at     timestamptz not null default now(),
  unique (ad_account_id, media, campaign_id)
);

create table if not exists public.adgroups (
  id             uuid primary key default gen_random_uuid(),
  ad_account_id  uuid not null references public.ad_accounts (id) on delete cascade,
  media          text not null check (media in ('sa', 'gfa')),
  adgroup_id     text not null,
  campaign_id    text,
  name           text,
  updated_at     timestamptz not null default now(),
  unique (ad_account_id, media, adgroup_id)
);

create table if not exists public.creatives (
  id               uuid primary key default gen_random_uuid(),
  ad_account_id    uuid not null references public.ad_accounts (id) on delete cascade,
  media            text not null check (media in ('sa', 'gfa')),
  creative_id      text not null,
  adgroup_id       text,
  campaign_id      text,
  name             text,
  product_name     text,         -- SA 쇼핑검색 소재의 상품명
  mall_product_id  text,
  updated_at       timestamptz not null default now(),
  unique (ad_account_id, media, creative_id)
);

-- ---------------------------------------------------------------------------
-- 4. 일별 성과 (한 행 = 매체 + 날짜 + 캠페인 + 세트 + 소재)
--    상위 단위만 있는 데이터(예: 캠페인 단위 GFA 파일)는 없는 단위를 '-' 로 채운다.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_performance_daily (
  id                  uuid primary key default gen_random_uuid(),
  ad_account_id       uuid not null references public.ad_accounts (id) on delete cascade,
  media               text not null check (media in ('sa', 'gfa')),
  stat_date           date not null,
  campaign_id         text not null default '-',
  adgroup_id          text not null default '-',
  creative_id         text not null default '-',
  campaign_type       text,
  impressions         bigint  not null default 0,
  clicks              bigint  not null default 0,
  cost                numeric(18, 2) not null default 0,
  avg_rank            numeric(10, 2),          -- SA 전용. 집계 시 노출수 가중평균
  conv_count          bigint  not null default 0,
  conv_revenue        numeric(18, 2) not null default 0,
  total_conv_count    bigint  not null default 0,
  total_conv_revenue  numeric(18, 2) not null default 0,
  cart_count          bigint  not null default 0,  -- GFA 전용
  cart_revenue        numeric(18, 2) not null default 0,
  source              text not null default 'api',  -- api | mock | gfa_import
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (ad_account_id, media, stat_date, campaign_id, adgroup_id, creative_id)
);

create index if not exists perf_date_idx
  on public.ad_performance_daily (ad_account_id, media, stat_date);
create index if not exists perf_campaign_idx
  on public.ad_performance_daily (ad_account_id, media, campaign_id, stat_date);
create index if not exists perf_adgroup_idx
  on public.ad_performance_daily (ad_account_id, media, adgroup_id, stat_date);

-- ---------------------------------------------------------------------------
-- 5. 수집 이력
-- ---------------------------------------------------------------------------
create table if not exists public.sync_logs (
  id             uuid primary key default gen_random_uuid(),
  ad_account_id  uuid references public.ad_accounts (id) on delete cascade,
  stat_date      date,
  status         text not null check (status in ('running', 'success', 'partial', 'failed')),
  mode           text not null default 'api',
  rows_fetched   integer not null default 0,
  rows_upserted  integer not null default 0,
  attempt        integer not null default 1,
  duration_ms    integer,
  message        text,
  detail         jsonb,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists sync_logs_idx on public.sync_logs (ad_account_id, started_at desc);

-- ============================================================================
-- 6. 집계 함수
-- ============================================================================
create or replace function public.safe_div(n numeric, d numeric)
returns numeric
language sql
immutable
as $$
  select case when d is null or d = 0 then 0 else n / d end;
$$;

-- p_media: 'sa' | 'gfa' | 'total'(= SA + GFA 합산)

-- 기간 KPI 합계 -----------------------------------------------------------------
drop function if exists public.fn_summary(uuid, text, date, date, text, text);
create or replace function public.fn_summary(
  p_account   uuid,
  p_media     text,
  p_from      date,
  p_to        date,
  p_campaign  text default null,
  p_adgroup   text default null
)
returns table (
  impressions bigint, clicks bigint, cost numeric,
  conv_count bigint, conv_revenue numeric,
  total_conv_count bigint, total_conv_revenue numeric,
  cart_count bigint, cart_revenue numeric,
  ctr numeric, cpc numeric, conv_roas numeric, total_roas numeric, cart_roas numeric,
  avg_rank numeric
)
language sql
stable
as $$
  with s as (
    select
      coalesce(sum(f.impressions), 0)::bigint        as impressions,
      coalesce(sum(f.clicks), 0)::bigint             as clicks,
      coalesce(sum(f.cost), 0)::numeric              as cost,
      coalesce(sum(f.conv_count), 0)::bigint         as conv_count,
      coalesce(sum(f.conv_revenue), 0)::numeric      as conv_revenue,
      coalesce(sum(f.total_conv_count), 0)::bigint   as total_conv_count,
      coalesce(sum(f.total_conv_revenue), 0)::numeric as total_conv_revenue,
      coalesce(sum(f.cart_count), 0)::bigint         as cart_count,
      coalesce(sum(f.cart_revenue), 0)::numeric      as cart_revenue,
      public.safe_div(
        sum(f.avg_rank * f.impressions) filter (where f.avg_rank is not null and f.impressions > 0),
        sum(f.impressions) filter (where f.avg_rank is not null and f.impressions > 0)
      ) as avg_rank
    from public.ad_performance_daily f
    where f.ad_account_id = p_account
      and (p_media = 'total' or f.media = p_media)
      and f.stat_date between p_from and p_to
      and (p_campaign is null or f.campaign_id = p_campaign)
      and (p_adgroup  is null or f.adgroup_id  = p_adgroup)
  )
  select
    s.impressions, s.clicks, s.cost,
    s.conv_count, s.conv_revenue, s.total_conv_count, s.total_conv_revenue,
    s.cart_count, s.cart_revenue,
    public.safe_div(s.clicks, s.impressions),
    public.safe_div(s.cost, s.clicks),
    public.safe_div(s.conv_revenue, s.cost),
    public.safe_div(s.total_conv_revenue, s.cost),
    public.safe_div(s.cart_revenue, s.cost),
    nullif(s.avg_rank, 0)
  from s;
$$;

-- 일별 추이 (데이터 없는 날은 0 으로 채움) --------------------------------------
drop function if exists public.fn_daily(uuid, text, date, date, text, text);
create or replace function public.fn_daily(
  p_account   uuid,
  p_media     text,
  p_from      date,
  p_to        date,
  p_campaign  text default null,
  p_adgroup   text default null
)
returns table (
  stat_date date,
  impressions bigint, clicks bigint, cost numeric,
  conv_count bigint, conv_revenue numeric,
  total_conv_count bigint, total_conv_revenue numeric,
  cart_count bigint, cart_revenue numeric,
  ctr numeric, cpc numeric, conv_roas numeric, total_roas numeric, cart_roas numeric
)
language sql
stable
as $$
  with days as (
    select d::date as stat_date from generate_series(p_from, p_to, interval '1 day') d
  ),
  agg as (
    select
      f.stat_date,
      sum(f.impressions)::bigint        as impressions,
      sum(f.clicks)::bigint             as clicks,
      sum(f.cost)::numeric              as cost,
      sum(f.conv_count)::bigint         as conv_count,
      sum(f.conv_revenue)::numeric      as conv_revenue,
      sum(f.total_conv_count)::bigint   as total_conv_count,
      sum(f.total_conv_revenue)::numeric as total_conv_revenue,
      sum(f.cart_count)::bigint         as cart_count,
      sum(f.cart_revenue)::numeric      as cart_revenue
    from public.ad_performance_daily f
    where f.ad_account_id = p_account
      and (p_media = 'total' or f.media = p_media)
      and f.stat_date between p_from and p_to
      and (p_campaign is null or f.campaign_id = p_campaign)
      and (p_adgroup  is null or f.adgroup_id  = p_adgroup)
    group by f.stat_date
  )
  select
    d.stat_date,
    coalesce(a.impressions, 0), coalesce(a.clicks, 0), coalesce(a.cost, 0),
    coalesce(a.conv_count, 0), coalesce(a.conv_revenue, 0),
    coalesce(a.total_conv_count, 0), coalesce(a.total_conv_revenue, 0),
    coalesce(a.cart_count, 0), coalesce(a.cart_revenue, 0),
    public.safe_div(a.clicks, a.impressions),
    public.safe_div(a.cost, a.clicks),
    public.safe_div(a.conv_revenue, a.cost),
    public.safe_div(a.total_conv_revenue, a.cost),
    public.safe_div(a.cart_revenue, a.cost)
  from days d
  left join agg a on a.stat_date = d.stat_date
  order by d.stat_date;
$$;

-- 캠페인 / 세트 / 소재별 성과 ---------------------------------------------------
--   p_level: 'campaign' | 'adgroup' | 'creative'
--   p_campaign, p_adgroup 으로 상위 단위를 좁힐 수 있다 (드릴다운).
drop function if exists public.fn_breakdown(uuid, text, date, date, text, text, text);
create or replace function public.fn_breakdown(
  p_account   uuid,
  p_media     text,
  p_from      date,
  p_to        date,
  p_level     text,
  p_campaign  text default null,
  p_adgroup   text default null
)
returns table (
  media text,
  campaign_id text, campaign_name text, campaign_type text,
  adgroup_id text, adgroup_name text,
  creative_id text, creative_name text, product_name text,
  child_count bigint,
  impressions bigint, clicks bigint, cost numeric,
  conv_count bigint, conv_revenue numeric,
  total_conv_count bigint, total_conv_revenue numeric,
  cart_count bigint, cart_revenue numeric,
  ctr numeric, cpc numeric, conv_roas numeric, total_roas numeric, cart_roas numeric,
  avg_rank numeric
)
language sql
stable
as $$
  with g as (
    select
      f.media                                                                as k_media,
      f.campaign_id                                                          as k_campaign,
      case when p_level in ('adgroup', 'creative') then f.adgroup_id end     as k_adgroup,
      case when p_level = 'creative' then f.creative_id end                  as k_creative,
      max(f.campaign_type)                                                   as campaign_type,
      case p_level
        when 'campaign' then count(distinct f.adgroup_id)
        when 'adgroup'  then count(distinct f.creative_id)
        else 0 end::bigint                                                   as child_count,
      sum(f.impressions)::bigint        as impressions,
      sum(f.clicks)::bigint             as clicks,
      sum(f.cost)::numeric              as cost,
      sum(f.conv_count)::bigint         as conv_count,
      sum(f.conv_revenue)::numeric      as conv_revenue,
      sum(f.total_conv_count)::bigint   as total_conv_count,
      sum(f.total_conv_revenue)::numeric as total_conv_revenue,
      sum(f.cart_count)::bigint         as cart_count,
      sum(f.cart_revenue)::numeric      as cart_revenue,
      public.safe_div(
        sum(f.avg_rank * f.impressions) filter (where f.avg_rank is not null and f.impressions > 0),
        sum(f.impressions) filter (where f.avg_rank is not null and f.impressions > 0)
      ) as avg_rank
    from public.ad_performance_daily f
    where f.ad_account_id = p_account
      and (p_media = 'total' or f.media = p_media)
      and f.stat_date between p_from and p_to
      and (p_campaign is null or f.campaign_id = p_campaign)
      and (p_adgroup  is null or f.adgroup_id  = p_adgroup)
    group by 1, 2, 3, 4
  )
  select
    g.k_media,
    g.k_campaign,
    coalesce(c.name, nullif(g.k_campaign, '-'), '(캠페인 정보 없음)'),
    coalesce(g.campaign_type, c.campaign_type),
    g.k_adgroup,
    case when g.k_adgroup is null then null
         else coalesce(a.name, nullif(g.k_adgroup, '-'), '(세트 정보 없음)') end,
    g.k_creative,
    case when g.k_creative is null then null
         else coalesce(cr.name, cr.product_name, nullif(g.k_creative, '-'), '(소재 정보 없음)') end,
    cr.product_name,
    g.child_count,
    g.impressions, g.clicks, g.cost,
    g.conv_count, g.conv_revenue, g.total_conv_count, g.total_conv_revenue,
    g.cart_count, g.cart_revenue,
    public.safe_div(g.clicks, g.impressions),
    public.safe_div(g.cost, g.clicks),
    public.safe_div(g.conv_revenue, g.cost),
    public.safe_div(g.total_conv_revenue, g.cost),
    public.safe_div(g.cart_revenue, g.cost),
    nullif(g.avg_rank, 0)
  from g
  left join public.campaigns c
    on c.ad_account_id = p_account and c.media = g.k_media and c.campaign_id = g.k_campaign
  left join public.adgroups a
    on a.ad_account_id = p_account and a.media = g.k_media and a.adgroup_id = g.k_adgroup
  left join public.creatives cr
    on cr.ad_account_id = p_account and cr.media = g.k_media and cr.creative_id = g.k_creative
  order by g.cost desc, g.impressions desc;
$$;

-- 날짜별 적재 현황 (GFA 업로드 확인·삭제 화면용) ---------------------------------
drop function if exists public.fn_media_dates(uuid, text, date, date);
create or replace function public.fn_media_dates(
  p_account uuid,
  p_media   text,
  p_from    date,
  p_to      date
)
returns table (stat_date date, row_count bigint, cost numeric, impressions bigint, uploaded_at timestamptz)
language sql
stable
as $$
  select f.stat_date, count(*)::bigint, sum(f.cost)::numeric, sum(f.impressions)::bigint, max(f.updated_at)
  from public.ad_performance_daily f
  where f.ad_account_id = p_account
    and f.media = p_media
    and f.stat_date between p_from and p_to
  group by f.stat_date
  order by f.stat_date desc;
$$;

-- RAW 데이터 화면용 (이름 붙인 행) ----------------------------------------------
create or replace view public.v_performance
with (security_invoker = on) as
select
  f.*,
  coalesce(c.name, nullif(f.campaign_id, '-'))  as campaign_name,
  coalesce(a.name, nullif(f.adgroup_id, '-'))   as adgroup_name,
  coalesce(cr.name, cr.product_name, nullif(f.creative_id, '-')) as creative_name
from public.ad_performance_daily f
left join public.campaigns c
  on c.ad_account_id = f.ad_account_id and c.media = f.media and c.campaign_id = f.campaign_id
left join public.adgroups a
  on a.ad_account_id = f.ad_account_id and a.media = f.media and a.adgroup_id = f.adgroup_id
left join public.creatives cr
  on cr.ad_account_id = f.ad_account_id and cr.media = f.media and cr.creative_id = f.creative_id;

-- ============================================================================
-- 7. 권한 (RLS)
--    관리자: 읽기 + 쓰기 / 조회 사용자: 읽기만 / 비로그인: 접근 불가
--    수집 함수(service_role)는 RLS 를 거치지 않는다.
-- ============================================================================
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'ad_accounts', 'campaigns', 'adgroups', 'creatives',
    'ad_performance_daily', 'sync_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array array[
    'ad_accounts', 'campaigns', 'adgroups', 'creatives', 'ad_performance_daily', 'sync_logs'
  ] loop
    execute format('drop policy if exists "%1$s_select" on public.%1$I', t);
    execute format(
      'create policy "%1$s_select" on public.%1$I for select to authenticated using (true)', t);
  end loop;

  foreach t in array array[
    'ad_accounts', 'campaigns', 'adgroups', 'creatives', 'ad_performance_daily'
  ] loop
    execute format('drop policy if exists "%1$s_write" on public.%1$I', t);
    execute format(
      'create policy "%1$s_write" on public.%1$I for all to authenticated
         using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end;
$$;

drop policy if exists "profiles_select_self" on public.profiles;
create policy "profiles_select_self" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 8. 확인 — 아래 표에 7개 테이블이 모두 "있음" 으로 나오면 성공
-- ============================================================================
select t.name as 테이블,
       case when to_regclass('public.' || t.name) is not null then '있음' else '없음' end as 상태
from (values ('profiles'), ('ad_accounts'), ('campaigns'), ('adgroups'),
             ('creatives'), ('ad_performance_daily'), ('sync_logs')) as t(name);
