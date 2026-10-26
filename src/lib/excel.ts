import * as XLSX from "xlsx";
import { BRAND_NAME } from "./brand";
import {
  MEDIA_LABEL, campaignTypeLabel,
  type BreakdownRow, type DailyPoint, type Media, type PeriodSummary, type RawRow,
} from "./types";

function sheet(rows: Record<string, unknown>[]) {
  return XLSX.utils.json_to_sheet(rows.length ? rows : [{ 안내: "데이터 없음" }]);
}

function download(wb: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(wb, filename.replace(/[\\/:*?"<>|]/g, "_"));
}

const r1 = (v: unknown) => Math.round(Number(v ?? 0));
const ratio = (v: unknown, digits = 4) => Number(Number(v ?? 0).toFixed(digits));

function metricCols(r: {
  impressions: number; clicks: number; ctr: number; cost: number; cpc: number;
  conv_count: number; conv_revenue: number; conv_roas: number;
  total_conv_count: number; total_conv_revenue: number; total_roas: number;
  cart_count: number; cart_revenue: number; cart_roas: number;
}, media: Media, avgRank?: number | null) {
  const base: Record<string, unknown> = {
    "노출수": r1(r.impressions),
    "클릭수": r1(r.clicks),
    "CTR": ratio(r.ctr),
    "광고비": r1(r.cost),
    "CPC": r1(r.cpc),
    "구매완료 수": r1(r.conv_count),
    "구매완료 매출": r1(r.conv_revenue),
    "구매완료 ROAS": ratio(r.conv_roas),
    "총 전환수": r1(r.total_conv_count),
    "총 전환매출": r1(r.total_conv_revenue),
    "총 전환 ROAS": ratio(r.total_roas),
  };
  if (media === "sa") {
    base["평균 노출순위"] = avgRank ? Number(Number(avgRank).toFixed(2)) : "";
  } else {
    base["장바구니 수"] = r1(r.cart_count);
    base["장바구니 매출"] = r1(r.cart_revenue);
    base["장바구니 ROAS"] = ratio(r.cart_roas);
  }
  return base;
}

/** 대시보드 엑셀: 요약 · 일별 · 캠페인별 · 세트별 · 소재별 */
export function exportReport(p: {
  media: Media; from: string; to: string; scopeLabel?: string;
  summary: PeriodSummary; daily: DailyPoint[];
  campaigns: BreakdownRow[]; adgroups: BreakdownRow[]; creatives: BreakdownRow[];
}) {
  const wb = XLSX.utils.book_new();
  const typeCol = (r: BreakdownRow) => (p.media === "sa" ? { "유형": campaignTypeLabel(r.campaign_type) } : {});

  const summaryRows = [
    { 항목: "매체", 값: MEDIA_LABEL[p.media] },
    { 항목: "조회 기간", 값: `${p.from} ~ ${p.to}` },
    ...(p.scopeLabel ? [{ 항목: "선택 범위", 값: p.scopeLabel }] : []),
    ...Object.entries(metricCols(p.summary, p.media, p.summary.avg_rank)).map(([k, v]) => ({ 항목: k, 값: v })),
  ];
  XLSX.utils.book_append_sheet(wb, sheet(summaryRows), "요약");

  XLSX.utils.book_append_sheet(wb, sheet(p.daily.map((d) => ({
    "날짜": d.stat_date, ...metricCols(d, p.media),
  }))), "일별 추이");

  XLSX.utils.book_append_sheet(wb, sheet(p.campaigns.map((r) => ({
    "캠페인": r.campaign_name, "캠페인 ID": r.campaign_id, ...typeCol(r),
    "세트 수": r1(r.child_count), ...metricCols(r, p.media, r.avg_rank),
  }))), "캠페인별");

  XLSX.utils.book_append_sheet(wb, sheet(p.adgroups.map((r) => ({
    "캠페인": r.campaign_name, ...typeCol(r), "세트": r.adgroup_name, "세트 ID": r.adgroup_id,
    "소재 수": r1(r.child_count), ...metricCols(r, p.media, r.avg_rank),
  }))), "세트별");

  XLSX.utils.book_append_sheet(wb, sheet(p.creatives.map((r) => ({
    "캠페인": r.campaign_name, ...typeCol(r), "세트": r.adgroup_name,
    "소재": r.creative_name, "소재 ID": r.creative_id,
    ...(p.media === "sa" ? { "상품명": r.product_name ?? "" } : {}),
    ...metricCols(r, p.media, r.avg_rank),
  }))), "소재별");

  download(wb, `${BRAND_NAME}_${MEDIA_LABEL[p.media]}_${p.from}_${p.to}.xlsx`);
}

/** RAW 데이터 엑셀 */
export function exportRaw(media: Media, from: string, to: string, rows: RawRow[]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(rows.map((r) => ({
    "날짜": r.stat_date,
    "캠페인": r.campaign_name ?? "", "캠페인 ID": r.campaign_id,
    ...(media === "sa" ? { "유형": campaignTypeLabel(r.campaign_type) } : {}),
    "세트": r.adgroup_name ?? "", "세트 ID": r.adgroup_id,
    "소재": r.creative_name ?? "", "소재 ID": r.creative_id,
    ...metricCols({
      ...r,
      ctr: r.impressions ? r.clicks / r.impressions : 0,
      cpc: r.clicks ? r.cost / r.clicks : 0,
      conv_roas: r.cost ? r.conv_revenue / r.cost : 0,
      total_roas: r.cost ? r.total_conv_revenue / r.cost : 0,
      cart_roas: r.cost ? r.cart_revenue / r.cost : 0,
    }, media, r.avg_rank),
    "출처": r.source,
  }))), "RAW");
  download(wb, `${BRAND_NAME}_${MEDIA_LABEL[media]}_RAW_${from}_${to}.xlsx`);
}
