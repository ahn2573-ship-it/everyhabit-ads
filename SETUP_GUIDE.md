# 에브리해빗 광고 대시보드 — 설치 가이드

초코펫하우스 대시보드와 같은 방식(GitHub + Supabase)이지만 **저장소·DB·로그인 계정이 완전히 분리**된 새 사이트입니다.

- 주소: `https://ahn2573-ship-it.github.io/everyhabit-ads/`
- SA: 네이버 검색광고 API로 **매일 오전 7시 자동 수집**
- GFA: **GFA 업로드** 화면에서 일별 RAW 파일 업로드
- 화면: 상단 **네이버 SA / 네이버 GFA** 탭 → **캠페인별 / 세트별 / 소재별** 표 (행을 누르면 하위로 들어감)

---

## 준비물

1. 에브리해빗 네이버 검색광고 **API Key / Secret Key / Customer ID**
   (네이버 검색광고 → 도구 → API 사용 관리)
2. Supabase **Access Token** (`sbp_...`) — 초코펫 때 만든 것을 그대로 써도 됩니다
   (supabase.com → 우측 상단 계정 → Access Tokens)

---

## 1단계 — Supabase 새 프로젝트

> ⚠️ 반드시 **새 프로젝트**. 초코펫 프로젝트에 넣으면 안 됩니다.

1. supabase.com → **New project** → 이름 `everyhabit-ads`, 리전 **Seoul**
2. 만들어지면 아래 4개를 메모장에 적어 두기
   - **Project ID** (Settings → General) — 예: `abcdxyz...`
   - **Project URL** = `https://<Project ID>.supabase.co`
   - **anon key** (Settings → API Keys → **Legacy API keys** 탭 → anon)
   - **service_role key** (같은 탭 → service_role → Reveal) — **`eyJ` 로 시작하는 긴 키**

## 2단계 — DB 만들기

1. Supabase → **SQL Editor** → 편집기를 **Ctrl+A → Delete** 로 비우기
2. `supabase/SETUP_1_database.sql` 전체 붙여넣기 → **Run**
3. 결과 표에 테이블 7개가 모두 **있음** 이면 성공

## 3단계 — GitHub 새 저장소

1. github.com (ahn2573-ship-it 계정) → **New repository**
   - 이름: **`everyhabit-ads`** (이 이름이 곧 주소)
   - **Public**, 나머지 옵션은 체크하지 않음 → Create
2. 빈 저장소 화면에서 **uploading an existing file** 클릭
3. 압축을 푼 `everyhabit-ads` 폴더 **안의 내용 전체**를 끌어다 놓기 → **Commit changes**
4. ⚠️ **확인**: 저장소 첫 화면에 **`.github`** 폴더가 보여야 합니다.
   안 보이면 (점으로 시작하는 폴더는 업로드에서 빠지는 경우가 있음):
   - **Add file → Create new file** → 파일 이름 칸에 `.github/workflows/deploy.yml` 입력
   - 압축 폴더의 같은 파일을 메모장으로 열어 전체 복사 → 붙여넣기 → Commit
   - `.github/workflows/deploy-functions.yml` 도 똑같이 한 번 더

## 4단계 — GitHub Secrets 8개

저장소 → **Settings → Secrets and variables → Actions → New repository secret**

| 이름 | 값 |
|---|---|
| `VITE_SUPABASE_URL` | `https://<Project ID>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_ACCESS_TOKEN` | `sbp_...` 액세스 토큰 |
| `SUPABASE_PROJECT_REF` | Project ID |
| `AD_API_KEY` | 에브리해빗 네이버 API Key |
| `AD_API_SECRET` | 에브리해빗 네이버 Secret Key |
| `AD_API_CUSTOMER_ID` | 에브리해빗 네이버 Customer ID |
| `AD_API_MODE` | `live` |

## 5단계 — 배포

1. 저장소 → **Settings → Pages** → Source: **GitHub Actions**
2. **Actions** 탭 → 두 작업을 각각 눌러 **Run workflow** (Secrets 를 넣기 전에 첫 업로드로 돌았던 작업은 실패/건너뜀일 수 있음)
   - `Deploy Supabase Edge Functions` → 초록불
   - `Deploy to GitHub Pages` → 초록불
3. 테스트 실패 메시지가 보여도 배포는 진행되게 되어 있습니다 (초코펫과 동일)

## 6단계 — 관리자 계정

1. Supabase → **Authentication → Users → Add user**
   이메일 + 비밀번호, **Auto Confirm User 체크**
2. SQL Editor (비우고):
   ```sql
   update public.profiles set role = 'admin' where email = '관리자_이메일';
   ```
3. 사이트 접속 → 로그인

> 조회만 하는 계정은 1번만 하면 됩니다 (기본이 조회 사용자).

## 7단계 — 자동 수집(매일 7시) 등록

1. `supabase/SETUP_2_cron.sql` 을 메모장으로 열기
2. `<PROJECT_REF>` → Project ID, `<SERVICE_ROLE>` → **eyJ 로 시작하는** service_role 키
   (꺾쇠 `< >` 까지 같이 지우기, 앞뒤 공백 없이)
3. SQL Editor 비우고 붙여넣기 → Run
4. 결과에서 `키_형식정상 = true`, `주소_정상 = true`, `active = true` 확인

## 8단계 — 첫 수집 & 검증

1. 사이트 → **SA 수집 이력** → 어제 날짜 **이 날짜 다시 수집** → 성공 확인
2. 대시보드 숫자 ↔ 네이버 검색광고 화면 숫자 비교
3. 과거 데이터: 같은 화면 **기간 일괄 수집** (하루씩, 최대 40일)
4. GFA: **GFA 업로드** → 일별 리포트 파일 올리기 → **반영 전 확인**에서 광고비 합계를 GFA 화면과 비교 → 반영하기

---

## GFA 업로드 요령

- GFA 리포트는 **일별**로 받아 주세요. 기간 합계 파일은 자동으로 막습니다.
- **광고 소재** 단위로 받으면 캠페인·세트·소재가 모두 나뉩니다.
  (광고 그룹 단위면 소재 구분 없음, 캠페인 단위면 캠페인만)
- 시간별/기기별/연령별 리포트 모두 가능 — 날짜+소재 기준으로 합산됩니다.
- **같은 날짜를 다시 올리면** 기본 설정(권장 체크)에서 그 날짜의 예전 GFA 데이터를 지우고 새로 넣습니다.
- 잘못 올렸으면 같은 화면 오른쪽 **날짜별 업로드 현황**의 휴지통, 또는 **기간 지정 삭제**로 지웁니다. SA 데이터는 영향 없음.

## 초코펫과 다른 점

- 상품군·상품 매핑·미매핑 연결·알림 기능 없음 (요청대로 단순화)
- SA 소재 이름은 네이버에서 자동으로 받아옴 (쇼핑검색 소재는 상품명)
- SA 를 같은 날짜로 다시 수집하면 그 날짜 SA 데이터를 통째로 갈아끼움 (예전 행이 남지 않음)
- 그날 노출 없이 **전환만 잡힌 소재**도 빠지지 않고 들어감
- 평균 노출순위는 처음부터 노출수 가중평균

## 이름 바꾸기 (필요할 때)

- 화면/엑셀의 업체명: `src/lib/brand.ts` 한 곳
- 브라우저 탭 제목: `index.html` 의 `<title>`
