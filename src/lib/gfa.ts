import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// 네이버 GFA RAW 리포트 파서 (형식 자동 인식 · 파일명 무관)
//   · 열 이름만 보고 필요한 값을 찾는다. 열 순서가 바뀌거나 안 쓰는 열이 많아도 된다.
//   · 시간별 / 기기별 / 연령·성별별 등 어떤 분해 리포트든
//     "날짜 + 캠페인 + 세트(광고그룹) + 소재" 단위로 합산하므로 합계는 같다.
//   · 파일에 없는 단위(예: 캠페인 단위 리포트의 세트·소재)는 '-' 로 둔다.
//   · ID 열이 없고 이름만 있으면 이름을 ID 대신 쓴다.
// ---------------------------------------------------------------------------

export interface GfaParsedRow {
  stat_date: string;        // YYYY-MM-DD
  campaign_id: string;
  campaign_name: string | null;
  adgroup_id: string;
  adgroup_name: string | null;
  creative_id: string;
  creative_name: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  conv_count: number;
  conv_revenue: number;
  total_conv_count: number;
  total_conv_revenue: number;
  cart_count: number;
  cart_revenue: number;
}

export type GfaLevel = "소재" | "세트" | "캠페인" | "알수없음";

export interface GfaParseResult {
  rows: GfaParsedRow[];
  rawCount: number;
  skipped: number;
  level: GfaLevel;
  /** 기간 합계 리포트(하루 단위가 아님)가 섞여 있으면 true — 이 경우 업로드를 막는다 */
  periodTotal: boolean;
  missingColumns: string[];
}

const NAME = {
  creative: ["광고 소재 이름", "소재 이름", "소재명", "광고소재 이름", "광고 소재명"],
  adgroup: ["광고 그룹 이름", "광고그룹 이름", "그룹 이름", "그룹명", "광고 그룹명", "광고그룹명"],
  campaign: ["캠페인 이름", "캠페인명"],
};
const ID = {
  creative: ["광고 소재 ID", "소재 ID", "소재ID", "광고소재 ID"],
  adgroup: ["광고 그룹 ID", "광고그룹 ID", "그룹 ID", "그룹ID", "광고그룹ID"],
  campaign: ["캠페인 ID", "캠페인ID"],
};
const METRIC = {
  date: ["기간", "날짜", "일자"],
  cost: ["총비용", "비용", "광고비", "총 비용"],
  imp: ["노출수", "노출"],
  clk: ["클릭수", "클릭"],
  conv: ["구매완료 수", "구매완료 전환수", "구매완료수"],
  rev: ["구매완료 전환매출액", "구매완료 매출", "구매완료 전환 매출액"],
  totalConv: ["총 전환수", "전환수"],
  totalRev: ["총 전환매출액", "전환매출액"],
  cartConv: ["장바구니 담기 수", "장바구니 전환수", "장바구니담기수"],
  cartRev: ["장바구니 전환매출액", "장바구니 매출", "장바구니 담기 전환매출액"],
};

// 헤더 비교용 정규화: 공백/BOM 제거 + 끝의 단위 괄호 "(원)","(%)" 제거
const norm = (s: string) => s.replace(/﻿/g, "").replace(/\s/g, "").replace(/\((?:원|%|VAT포함|VAT 포함)\)$/g, "");

/** 후보 이름들 중 실제 파일에 있는 열 이름을 찾는다. 없으면 null */
function findColumn(headers: string[], keys: string[]): string | null {
  for (const k of keys) if (headers.includes(k)) return k;
  for (const k of keys) {
    const hit = headers.find((h) => norm(h) === norm(k));
    if (hit) return hit;
  }
  return null;
}

const toNum = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const toText = (v: unknown): string => String(v ?? "").trim();

function ymd(y: number | string, m: number | string, d: number | string) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 날짜 칸을 읽는다. "2026.10.01. ~ 2026.10.21." 처럼 서로 다른 두 날짜면 period=true */
export function parseDateCell(v: unknown): { date: string | null; period: boolean } {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { date: ymd(v.getFullYear(), v.getMonth() + 1, v.getDate()), period: false };
  }
  const s = toText(v);
  const all = [...s.matchAll(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/g)].map((m) => ymd(m[1], m[2], m[3]));
  if (all.length) return { date: all[0], period: new Set(all).size > 1 };
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return { date: ymd(compact[1], compact[2], compact[3]), period: false };
  if (/^\d+(\.\d+)?$/.test(s)) {
    // 엑셀 날짜 일련번호
    const dt = (XLSX as unknown as { SSF?: { parse_date_code?: (n: number) => { y: number; m: number; d: number } } })
      .SSF?.parse_date_code?.(Number(s));
    if (dt) return { date: ymd(dt.y, dt.m, dt.d), period: false };
  }
  return { date: null, period: false };
}

/** 이미 읽은 표(행 객체 배열)를 합산한다. 파일 읽기와 분리해 테스트하기 쉽게 둔다. */
export function aggregateGfaRows(json: Record<string, unknown>[]): GfaParseResult {
  if (!json.length) {
    return { rows: [], rawCount: 0, skipped: 0, level: "알수없음", periodTotal: false, missingColumns: [] };
  }
  const headers = Object.keys(json[0]);
  const col = {
    cId: findColumn(headers, ID.campaign), cName: findColumn(headers, NAME.campaign),
    gId: findColumn(headers, ID.adgroup), gName: findColumn(headers, NAME.adgroup),
    aId: findColumn(headers, ID.creative), aName: findColumn(headers, NAME.creative),
    date: findColumn(headers, METRIC.date),
    cost: findColumn(headers, METRIC.cost), imp: findColumn(headers, METRIC.imp),
    clk: findColumn(headers, METRIC.clk), conv: findColumn(headers, METRIC.conv),
    rev: findColumn(headers, METRIC.rev), totalConv: findColumn(headers, METRIC.totalConv),
    totalRev: findColumn(headers, METRIC.totalRev), cartConv: findColumn(headers, METRIC.cartConv),
    cartRev: findColumn(headers, METRIC.cartRev),
  };

  const missingColumns: string[] = [];
  if (!col.date) missingColumns.push("기간(날짜)");
  if (!col.cost) missingColumns.push("총비용");
  if (!col.cId && !col.cName && !col.gId && !col.gName && !col.aId && !col.aName) {
    missingColumns.push("캠페인/광고 그룹/광고 소재 이름 또는 ID");
  }

  const hasCreative = Boolean(col.aId || col.aName);
  const hasGroup = Boolean(col.gId || col.gName);
  const level: GfaLevel = hasCreative ? "소재" : hasGroup ? "세트" : (col.cId || col.cName) ? "캠페인" : "알수없음";

  const get = (r: Record<string, unknown>, c: string | null) => (c ? r[c] : "");
  const map = new Map<string, GfaParsedRow>();
  let skipped = 0;
  let periodTotal = false;

  for (const r of json) {
    const { date, period } = parseDateCell(get(r, col.date));
    if (period) periodTotal = true;

    const cName = toText(get(r, col.cName)) || null;
    const gName = toText(get(r, col.gName)) || null;
    const aName = toText(get(r, col.aName)) || null;
    const campaign_id = toText(get(r, col.cId)) || cName || "-";
    const adgroup_id = toText(get(r, col.gId)) || gName || "-";
    const creative_id = toText(get(r, col.aId)) || aName || "-";

    // 합계 행("합계", "총합" 등)과 빈 행은 건너뛴다
    const label = `${cName ?? ""}${gName ?? ""}${aName ?? ""}`;
    if (!date || /^(합계|총합|전체|total)$/i.test(label.trim()) ||
        (campaign_id === "-" && adgroup_id === "-" && creative_id === "-")) {
      skipped++;
      continue;
    }

    const key = `${date}|${campaign_id}|${adgroup_id}|${creative_id}`;
    const cur = map.get(key) ?? {
      stat_date: date, campaign_id, campaign_name: cName, adgroup_id, adgroup_name: gName,
      creative_id, creative_name: aName,
      impressions: 0, clicks: 0, cost: 0, conv_count: 0, conv_revenue: 0,
      total_conv_count: 0, total_conv_revenue: 0, cart_count: 0, cart_revenue: 0,
    };
    const conv = toNum(get(r, col.conv));
    const rev = toNum(get(r, col.rev));
    cur.impressions += toNum(get(r, col.imp));
    cur.clicks += toNum(get(r, col.clk));
    cur.cost += toNum(get(r, col.cost));
    cur.conv_count += conv;
    cur.conv_revenue += rev;
    cur.total_conv_count += col.totalConv ? toNum(get(r, col.totalConv)) : conv;
    cur.total_conv_revenue += col.totalRev ? toNum(get(r, col.totalRev)) : rev;
    cur.cart_count += toNum(get(r, col.cartConv));
    cur.cart_revenue += toNum(get(r, col.cartRev));
    map.set(key, cur);
  }

  return { rows: [...map.values()], rawCount: json.length, skipped, level, periodTotal, missingColumns };
}

/** GFA RAW 파일(.csv/.xlsx)을 읽어 합산한다. */
export async function parseGfaFile(file: File): Promise<GfaParseResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  return aggregateGfaRows(json);
}

/**
 * 여러 파일 결과를 합친다.
 * 같은 날짜·같은 소재가 두 파일에 다 있으면 (예: 시간별 + 기기별 리포트를 둘 다 올림)
 * 더하지 않고 나중 파일 값으로 덮어쓴다 — 같은 성과를 두 번 세지 않기 위해.
 */
export function mergeFiles(results: GfaParsedRow[][]): GfaParsedRow[] {
  const map = new Map<string, GfaParsedRow>();
  for (const rows of results) {
    for (const r of rows) map.set(`${r.stat_date}|${r.campaign_id}|${r.adgroup_id}|${r.creative_id}`, r);
  }
  return [...map.values()];
}
