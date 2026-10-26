import { describe, expect, it } from "vitest";
import { aggregateGfaRows, mergeFiles, parseDateCell } from "../src/lib/gfa";

const row = (o: Record<string, unknown>) => ({
  "기간": "2026.10.21.", "캠페인 ID": "c1", "캠페인 이름": "전환_리타겟",
  "광고 그룹 ID": "g1", "광고 그룹 이름": "세트A",
  "광고 소재 ID": "a1", "광고 소재 이름": "소재1",
  "총비용(원)": "1,000", "노출수": 100, "클릭수": 5,
  "구매완료 수": 1, "구매완료 전환매출액(원)": "30,000",
  "장바구니 담기 수": 2, ...o,
});

describe("GFA 파서", () => {
  it("시간별처럼 쪼개진 행을 날짜+캠페인+세트+소재로 합산한다", () => {
    const res = aggregateGfaRows([row({ "시간": 1 }), row({ "시간": 2 }), row({ "광고 소재 ID": "a2", "광고 소재 이름": "소재2" })]);
    expect(res.level).toBe("소재");
    expect(res.rows).toHaveLength(2);
    const a1 = res.rows.find((r) => r.creative_id === "a1")!;
    expect(a1).toMatchObject({
      stat_date: "2026-10-21", campaign_id: "c1", campaign_name: "전환_리타겟",
      adgroup_id: "g1", adgroup_name: "세트A", creative_name: "소재1",
      cost: 2000, impressions: 200, clicks: 10, conv_count: 2, conv_revenue: 60000, cart_count: 4,
    });
    // 총 전환 열이 없으면 구매완료 값으로 채운다
    expect(a1.total_conv_count).toBe(2);
  });

  it("캠페인 단위 파일은 세트·소재를 '-' 로 둔다", () => {
    const res = aggregateGfaRows([{ "기간": "2026-10-21", "캠페인 이름": "브랜드", "총비용": 500, "노출수": 10 }]);
    expect(res.level).toBe("캠페인");
    expect(res.rows[0]).toMatchObject({ campaign_id: "브랜드", adgroup_id: "-", creative_id: "-", cost: 500 });
  });

  it("기간 합계 리포트를 알아챈다", () => {
    expect(parseDateCell("2026.10.01. ~ 2026.10.21.")).toEqual({ date: "2026-10-01", period: true });
    expect(parseDateCell("2026.10.21.")).toEqual({ date: "2026-10-21", period: false });
    expect(aggregateGfaRows([row({ "기간": "2026.10.01. ~ 2026.10.21." })]).periodTotal).toBe(true);
  });

  it("합계 행과 날짜 없는 행은 건너뛴다", () => {
    const res = aggregateGfaRows([row({}), row({ "기간": "", "캠페인 이름": "합계" })]);
    expect(res.rows).toHaveLength(1);
    expect(res.skipped).toBe(1);
  });

  it("필수 열이 없으면 알려준다", () => {
    expect(aggregateGfaRows([{ "노출수": 1 }]).missingColumns).toEqual(
      expect.arrayContaining(["기간(날짜)", "총비용"]),
    );
  });

  it("두 파일에 같은 소재·날짜가 있으면 더하지 않고 나중 값으로 덮는다", () => {
    const a = aggregateGfaRows([row({})]).rows;
    const b = aggregateGfaRows([row({ "총비용(원)": 1500 })]).rows;
    const merged = mergeFiles([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].cost).toBe(1500);
  });
});
