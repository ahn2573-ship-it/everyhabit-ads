import type { MetricBundle } from "./types";

/** 분모가 0이면 오류 대신 0. DB 의 safe_div 와 동작을 일치시킨다. */
export function safeDiv(numerator: number, denominator: number): number {
  if (!denominator || !Number.isFinite(denominator)) return 0;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : 0;
}

export const ctr = (clicks: number, impressions: number) => safeDiv(clicks, impressions);
export const cpc = (cost: number, clicks: number) => safeDiv(cost, clicks);
export const roas = (revenue: number, cost: number) => safeDiv(revenue, cost);

export interface SumInput {
  impressions: number;
  clicks: number;
  cost: number;
  conv_count: number;
  conv_revenue: number;
  total_conv_count: number;
  total_conv_revenue: number;
  cart_count?: number;
  cart_revenue?: number;
}

/**
 * 원본 행들을 합산한 뒤 비율 지표를 다시 계산한다.
 * 비율의 평균을 내면 안 된다.
 */
export function aggregate(rows: SumInput[]): MetricBundle {
  const sum = {
    impressions: 0, clicks: 0, cost: 0, conv_count: 0, conv_revenue: 0,
    total_conv_count: 0, total_conv_revenue: 0, cart_count: 0, cart_revenue: 0,
  };
  for (const r of rows) {
    sum.impressions += Number(r.impressions) || 0;
    sum.clicks += Number(r.clicks) || 0;
    sum.cost += Number(r.cost) || 0;
    sum.conv_count += Number(r.conv_count) || 0;
    sum.conv_revenue += Number(r.conv_revenue) || 0;
    sum.total_conv_count += Number(r.total_conv_count) || 0;
    sum.total_conv_revenue += Number(r.total_conv_revenue) || 0;
    sum.cart_count += Number(r.cart_count) || 0;
    sum.cart_revenue += Number(r.cart_revenue) || 0;
  }
  return {
    ...sum,
    ctr: ctr(sum.clicks, sum.impressions),
    cpc: cpc(sum.cost, sum.clicks),
    conv_roas: roas(sum.conv_revenue, sum.cost),
    total_roas: roas(sum.total_conv_revenue, sum.cost),
    cart_roas: roas(sum.cart_revenue, sum.cost),
  };
}

/** 지표가 올라가는 게 좋은지 내려가는 게 좋은지 */
export type Direction = "up-good" | "down-good" | "neutral";

export const METRIC_DIRECTION: Record<string, Direction> = {
  impressions: "up-good",
  clicks: "up-good",
  ctr: "up-good",
  cost: "neutral",       // 광고비 증가 자체는 좋지도 나쁘지도 않다
  cpc: "down-good",
  conv_count: "up-good",
  conv_revenue: "up-good",
  conv_roas: "up-good",
  total_conv_count: "up-good",
  total_conv_revenue: "up-good",
  total_roas: "up-good",
  cart_count: "up-good",
  cart_revenue: "up-good",
  cart_roas: "up-good",
  avg_rank: "down-good",   // 순위는 숫자가 작을수록 좋다
};

export interface Delta {
  /** 변화율(%) — 이전 값이 0이면 null */
  pct: number | null;
  diff: number;
  tone: "good" | "bad" | "flat";
}

export function delta(current: number, previous: number, key: string): Delta {
  const diff = current - previous;
  const pct = previous === 0 ? null : (diff / Math.abs(previous)) * 100;
  const direction = METRIC_DIRECTION[key] ?? "neutral";

  let tone: Delta["tone"] = "flat";
  if (Math.abs(diff) > 1e-9 && direction !== "neutral") {
    const isUp = diff > 0;
    tone = (direction === "up-good") === isUp ? "good" : "bad";
  }
  return { pct, diff, tone };
}
