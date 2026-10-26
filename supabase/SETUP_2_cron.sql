-- ============================================================================
-- 에브리해빗 — 매일 오전 7시(한국시간) SA 자동 수집 등록
--
--  바꿀 곳 2군데 (꺾쇠 < > 까지 같이 지우고, 앞뒤 공백 없이):
--    <PROJECT_REF>   → 새 Supabase 프로젝트 ID (Settings → General → Project ID)
--    <SERVICE_ROLE>  → service_role 키
--                      (Settings → API Keys → "Legacy API keys" 탭 → service_role → Reveal)
--      ★ 반드시 eyJ 로 시작하는 아주 긴 키. sb_secret_ 로 시작하는 키를 넣으면
--        "Invalid JWT" 로 거절당해 자동 수집이 안 됩니다. (초코펫에서 겪었던 문제)
--
--  SQL Editor 를 Ctrl+A → Delete 로 비운 뒤 붙여넣고 Run.
--  여러 번 실행해도 안전합니다 (기존 등록을 지우고 새로 넣음).
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  perform cron.unschedule('sync-ads-daily');
exception when others then
  null;
end $$;

-- UTC 22시 = 한국 오전 7시. 응답 대기 150초 (네이버 보고서 생성 대기 때문)
select cron.schedule(
  'sync-ads-daily',
  '0 22 * * *',
  $CRON$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-ads',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE>'
    ),
    body    := jsonb_build_object('mode', 'auto'),
    timeout_milliseconds := 150000
  );
  $CRON$
);

-- 확인: schedule = 0 22 * * *, active = true, 키_형식정상 = true, 주소_정상 = true 면 성공
select jobid,
       jobname,
       schedule,
       active,
       command like '%Bearer eyJ%'          as "키_형식정상",
       command not like '%<PROJECT_REF>%'   as "주소_정상"
from cron.job
where jobname = 'sync-ads-daily';
