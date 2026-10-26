# 에브리해빗 광고 대시보드

네이버 SA(검색광고 API 자동 수집) + 네이버 GFA(RAW 업로드) 성과를
캠페인 → 세트 → 소재 단위로 보는 대시보드입니다.

- 설치 방법: [`SETUP_GUIDE.md`](./SETUP_GUIDE.md)
- DB: `supabase/SETUP_1_database.sql`, 자동 수집: `supabase/SETUP_2_cron.sql`
- 수집 함수: `supabase/functions/sync-ads/`
- 화면: `src/pages/` (Dashboard · RawData · GfaUpload · SyncLogs)
