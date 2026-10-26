-- ============================================================================
-- 에브리해빗 — 대시보드 "전체(SA+GFA)" 탭용 집계 함수 업데이트 (2026-10-26)
--
--  이미 SETUP_1 을 실행한 DB 에 한 번만 실행하면 됩니다. (여러 번 실행해도 안전)
--  데이터는 건드리지 않고, 집계 함수 3개(fn_summary · fn_daily · fn_breakdown)만 바꿉니다.
--  SQL Editor 를 Ctrl+A → Delete 로 비운 뒤 붙여넣고 Run.
-- ============================================================================

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

grant execute on function
  public.fn_summary(uuid, text, date, date, text, text),
  public.fn_daily(uuid, text, date, date, text, text),
  public.fn_breakdown(uuid, text, date, date, text, text, text)
to authenticated, service_role;

-- 확인: 아래 표에 3줄이 나오고 "전체지원" 이 모두 true 면 성공
select p.proname as 함수,
       pg_get_functiondef(p.oid) like '%''total''%' as 전체지원
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('fn_summary', 'fn_daily', 'fn_breakdown')
order by 1;
