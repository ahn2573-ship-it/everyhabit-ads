import type { NormalizedRow } from "./types.ts";

export function toNumber(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Date 객체를 Asia/Seoul 기준 YYYY-MM-DD 로 변환 */
export function seoulDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Asia/Seoul 기준 전일 */
export function seoulYesterday(): string {
  const today = seoulDate();
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/** 캠페인 ID(cmp-a001-02-…)에서 유형 코드(02)를 뽑는다. */
export function campaignTypeOf(campaignId: string): string | null {
  return campaignId.match(/^cmp-a\d+-(\d+)-/)?.[1] ?? null;
}

/**
 * 같은 키(날짜+캠페인+세트+소재)로 중복 들어온 행을 합친다.
 * 지표는 합산, 평균노출순위는 노출수 가중평균.
 */
export function dedupeRows(rows: NormalizedRow[]): NormalizedRow[] {
  const map = new Map<string, NormalizedRow>();
  for (const r of rows) {
    const key = `${r.statDate}|${r.campaignId}|${r.adgroupId}|${r.creativeId}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r });
      continue;
    }
    const prevW = prev.avgRank !== null ? prev.impressions : 0;
    const curW = r.avgRank !== null ? r.impressions : 0;
    prev.avgRank = prevW + curW > 0
      ? ((prev.avgRank ?? 0) * prevW + (r.avgRank ?? 0) * curW) / (prevW + curW)
      : (prev.avgRank ?? r.avgRank);
    prev.impressions += r.impressions;
    prev.clicks += r.clicks;
    prev.cost += r.cost;
    prev.convCount += r.convCount;
    prev.convRevenue += r.convRevenue;
    prev.totalConvCount += r.totalConvCount;
    prev.totalConvRevenue += r.totalConvRevenue;
  }
  return [...map.values()];
}
