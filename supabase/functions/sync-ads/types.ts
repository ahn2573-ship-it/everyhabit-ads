// 광고 API 어댑터가 지켜야 하는 내부 표준 구조.

/** 소재 단위 일별 성과 한 줄 */
export interface NormalizedRow {
  /** YYYY-MM-DD, Asia/Seoul 기준 */
  statDate: string;
  campaignId: string;   // 없으면 '-'
  adgroupId: string;    // 없으면 '-'
  creativeId: string;   // 없으면 '-'
  /** 캠페인 유형 코드 (01=파워링크, 02=쇼핑검색, 04=브랜드검색 …). 없으면 null */
  campaignType: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  avgRank: number | null;
  convCount: number;
  convRevenue: number;
  totalConvCount: number;
  totalConvRevenue: number;
}

/** 캠페인 / 세트 / 소재 이름표 */
export interface NameBook {
  campaigns: Array<{ id: string; name: string | null; campaignType: string | null }>;
  adgroups: Array<{ id: string; campaignId: string | null; name: string | null }>;
  creatives: Array<{
    id: string; adgroupId: string | null; campaignId: string | null;
    name: string | null; productName: string | null; mallProductId: string | null;
  }>;
}

export interface FetchParams {
  statDate: string; // YYYY-MM-DD (Asia/Seoul)
}

export interface AdAdapter {
  name: string;
  fetchDaily(params: FetchParams): Promise<NormalizedRow[]>;
  /** 성과에 등장한 캠페인/세트/소재의 이름을 가져온다. 실패해도 수집은 계속된다. */
  fetchNames(rows: NormalizedRow[]): Promise<NameBook>;
}
