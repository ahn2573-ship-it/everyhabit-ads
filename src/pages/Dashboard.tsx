import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Download, RefreshCw, Search, Upload } from "lucide-react";
import { useAppState } from "@/hooks/useAppState";
import { useAuth } from "@/hooks/useAuth";
import { api, type Scope } from "@/lib/supabase";
import { COMPARE_LABELS, comparisonRange } from "@/lib/dateRange";
import { exportReport } from "@/lib/excel";
import { decimal, num, pct, roasPct, won } from "@/lib/format";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/layout/AppShell";
import { PeriodFilter } from "@/components/layout/PeriodFilter";
import { KpiStrip } from "@/components/KpiStrip";
import { DataTable, type Column } from "@/components/DataTable";
import { CostRevenueChart, DailyTrendChart } from "@/components/charts/Charts";
import { Badge, Button, ErrorState, Input } from "@/components/ui";
import {
  LEVEL_LABEL, MEDIA_LABEL, campaignTypeLabel,
  type BreakdownRow, type Level, type Media,
} from "@/lib/types";

interface Picked { id: string; name: string }

const LEVELS: Level[] = ["campaign", "adgroup", "creative"];

function rowName(r: BreakdownRow, level: Level): string {
  if (level === "campaign") return r.campaign_name;
  if (level === "adgroup") return r.adgroup_name ?? "";
  return r.creative_name ?? "";
}

function rowKey(r: BreakdownRow): string {
  return `${r.campaign_id}|${r.adgroup_id ?? ""}|${r.creative_id ?? ""}`;
}

function buildColumns(level: Level, media: Media, showParents: boolean): Column<BreakdownRow>[] {
  const nameCol: Column<BreakdownRow> = {
    key: "name",
    header: LEVEL_LABEL[level],
    value: (r) => rowName(r, level),
    render: (r) => {
      const name = rowName(r, level);
      const parents = level === "adgroup"
        ? [r.campaign_name]
        : level === "creative" ? [r.campaign_name, r.adgroup_name ?? ""] : [];
      const id = level === "campaign" ? r.campaign_id : level === "adgroup" ? r.adgroup_id : r.creative_id;
      return (
        <div className="min-w-[220px] max-w-[420px]">
          <p className="truncate font-medium text-ink" title={name}>{name}</p>
          {level === "creative" && r.product_name && r.product_name !== name && (
            <p className="truncate text-2xs text-ink-muted" title={r.product_name}>상품 · {r.product_name}</p>
          )}
          {showParents && parents.length > 0 && (
            <p className="truncate text-2xs text-ink-faint" title={parents.join(" › ")}>
              {parents.join(" › ")}
            </p>
          )}
          {id && id !== name && id !== "-" && (
            <p className="truncate font-mono text-[10px] text-ink-faint">{id}</p>
          )}
        </div>
      );
    },
  };

  const cols: Column<BreakdownRow>[] = [nameCol];

  if (media === "sa") {
    cols.push({
      key: "type", header: "유형",
      value: (r) => campaignTypeLabel(r.campaign_type),
      render: (r) => r.campaign_type ? <Badge>{campaignTypeLabel(r.campaign_type)}</Badge> : "",
    });
  }
  if (level !== "creative") {
    cols.push({
      key: "children", header: level === "campaign" ? "세트 수" : "소재 수", align: "right",
      value: (r) => Number(r.child_count), render: (r) => num(r.child_count),
    });
  }

  const n = (key: keyof BreakdownRow, header: string, fmt: (v: number) => string, hidden = false): Column<BreakdownRow> => ({
    key: key as string, header, align: "right", hidden,
    value: (r) => Number(r[key] ?? 0),
    render: (r) => fmt(Number(r[key] ?? 0)),
  });

  cols.push(
    n("impressions", "노출수", num),
    n("clicks", "클릭수", num),
    n("ctr", "CTR", (v) => pct(v)),
    n("cost", "광고비", won),
    n("cpc", "CPC", won),
    n("conv_count", "구매완료 수", num),
    n("conv_revenue", "구매완료 매출", won),
    n("conv_roas", "구매완료 ROAS", (v) => roasPct(v)),
    n("total_conv_count", "총 전환수", num, true),
    n("total_conv_revenue", "총 전환매출", won, true),
    n("total_roas", "총 전환 ROAS", (v) => roasPct(v), true),
  );
  if (media === "sa") {
    cols.push({
      key: "avg_rank", header: "평균 순위", align: "right",
      value: (r) => (r.avg_rank === null ? null : Number(r.avg_rank)),
      render: (r) => (r.avg_rank ? decimal(r.avg_rank, 1) : "—"),
    });
  } else {
    cols.push(
      n("cart_count", "장바구니 수", num, true),
      n("cart_revenue", "장바구니 매출", won, true),
      n("cart_roas", "장바구니 ROAS", (v) => roasPct(v), true),
    );
  }
  return cols;
}

export function Dashboard() {
  const { accountId, range, compare, media } = useAppState();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();

  const [level, setLevel] = useState<Level>("campaign");
  const [campaign, setCampaign] = useState<Picked | null>(null);
  const [adgroup, setAdgroup] = useState<Picked | null>(null);
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // 매체를 바꾸면 드릴다운을 처음으로 되돌린다 (SA 와 GFA 는 캠페인이 다르다)
  useEffect(() => {
    setLevel("campaign");
    setCampaign(null);
    setAdgroup(null);
    setSearch("");
  }, [media]);

  const enabled = Boolean(accountId);
  const scope: Scope = {
    account: accountId ?? "", media, from: range.from, to: range.to,
    campaignId: campaign?.id ?? null, adgroupId: adgroup?.id ?? null,
  };
  const prevRange = comparisonRange(range, compare);

  const summary = useQuery({ queryKey: ["summary", scope], queryFn: () => api.summary(scope), enabled });
  const prevSummary = useQuery({
    queryKey: ["summary", { ...scope, from: prevRange?.from, to: prevRange?.to }],
    queryFn: () => api.summary({ ...scope, from: prevRange!.from, to: prevRange!.to }),
    enabled: enabled && Boolean(prevRange),
  });
  const daily = useQuery({ queryKey: ["daily", scope], queryFn: () => api.daily(scope), enabled });
  const breakdown = useQuery({
    queryKey: ["breakdown", scope, level],
    queryFn: () => api.breakdown({ ...scope, level }),
    enabled,
  });

  const rows = useMemo(() => {
    const all = breakdown.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.campaign_name, r.adgroup_name, r.creative_name, r.product_name, r.campaign_id, r.adgroup_id, r.creative_id]
        .some((v) => v && v.toLowerCase().includes(q)));
  }, [breakdown.data, search]);

  const showParents = (level === "adgroup" && !campaign) || (level === "creative" && !adgroup);
  const columns = useMemo(() => buildColumns(level, media, showParents), [level, media, showParents]);

  const top10 = useMemo(() => (breakdown.data ?? []).slice(0, 10).map((r) => ({
    name: rowName(r, level), cost: Number(r.cost), revenue: Number(r.conv_revenue), row: r,
  })), [breakdown.data, level]);

  function drill(r: BreakdownRow) {
    if (level === "campaign") {
      setCampaign({ id: r.campaign_id, name: r.campaign_name });
      setAdgroup(null);
      setLevel("adgroup");
      setSearch("");
    } else if (level === "adgroup" && r.adgroup_id) {
      setCampaign({ id: r.campaign_id, name: r.campaign_name });
      setAdgroup({ id: r.adgroup_id, name: r.adgroup_name ?? r.adgroup_id });
      setLevel("creative");
      setSearch("");
    }
  }

  function goTop() {
    setCampaign(null);
    setAdgroup(null);
    setLevel("campaign");
  }

  async function handleSync() {
    if (!accountId) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await api.triggerSync({ account: accountId });
      setSyncMessage(res.ok
        ? `전일 SA 수집 완료 — ${num(res.upserted ?? 0)}건 반영` +
          (res.nameError ? ` (이름 일부 갱신 실패: ${res.nameError})` : "")
        : `수집 실패 — ${res.error ?? "원인 미상"}`);
      await Promise.all([summary.refetch(), daily.refetch(), breakdown.refetch()]);
    } catch (e) {
      setSyncMessage(e instanceof Error ? e.message : "수집 요청에 실패했습니다.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleExport() {
    if (!accountId || !summary.data) return;
    setExporting(true);
    try {
      const [campaigns, adgroups, creatives] = await Promise.all(
        LEVELS.map((lv) => api.breakdown({ ...scope, level: lv })),
      );
      exportReport({
        media, from: range.from, to: range.to,
        scopeLabel: [campaign?.name, adgroup?.name].filter(Boolean).join(" › "),
        summary: summary.data, daily: daily.data ?? [], campaigns, adgroups, creatives,
      });
    } finally {
      setExporting(false);
    }
  }

  if (summary.error) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;

  return (
    <>
      <PageHeader
        title={`대시보드 · ${MEDIA_LABEL[media]}`}
        description={media === "sa"
          ? "네이버 검색광고 API 로 매일 오전 7시에 자동 수집된 데이터입니다"
          : "업로드한 네이버 GFA RAW 파일 기준 데이터입니다"}
        actions={
          <>
            <Button size="md" onClick={handleExport} disabled={!summary.data} loading={exporting}>
              <Download className="h-3.5 w-3.5" /> 엑셀 다운로드
            </Button>
            {isAdmin && media === "sa" && (
              <Button size="md" variant="primary" onClick={handleSync} loading={syncing}>
                <RefreshCw className="h-3.5 w-3.5" /> 전일 데이터 수집
              </Button>
            )}
            {isAdmin && media === "gfa" && (
              <Button size="md" variant="primary" onClick={() => navigate("/gfa")}>
                <Upload className="h-3.5 w-3.5" /> GFA 파일 올리기
              </Button>
            )}
          </>
        }
      />

      {syncMessage && (
        <div className="mb-3 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-muted">
          {syncMessage}
        </div>
      )}

      <PeriodFilter />

      {/* 드릴다운 경로 */}
      <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm" aria-label="선택 경로">
        <button
          onClick={goTop}
          className={cn("rounded px-1.5 py-0.5 hover:bg-surface-sunken",
            !campaign ? "font-semibold text-ink" : "text-brand-700")}
        >
          전체 캠페인
        </button>
        {campaign && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />
            <button
              onClick={() => { setAdgroup(null); setLevel("adgroup"); }}
              className={cn("max-w-xs truncate rounded px-1.5 py-0.5 hover:bg-surface-sunken",
                !adgroup ? "font-semibold text-ink" : "text-brand-700")}
              title={campaign.name}
            >
              {campaign.name}
            </button>
          </>
        )}
        {adgroup && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />
            <span className="max-w-xs truncate px-1.5 py-0.5 font-semibold" title={adgroup.name}>
              {adgroup.name}
            </span>
          </>
        )}
      </nav>

      <KpiStrip
        current={summary.data}
        previous={prevRange ? prevSummary.data : undefined}
        series={daily.data}
        compareLabel={COMPARE_LABELS[compare]}
        loading={summary.isLoading}
        media={media}
      />

      {/* 캠페인 / 세트 / 소재 표 */}
      <div className="mt-4">
        <DataTable
          key={`${media}|${level}|${campaign?.id ?? ""}|${adgroup?.id ?? ""}`}
          columns={columns}
          rows={rows}
          loading={breakdown.isLoading}
          rowKey={rowKey}
          onRowClick={level === "creative" ? undefined : drill}
          defaultSort={{ key: "cost", dir: "desc" }}
          emptyTitle="이 기간에는 데이터가 없습니다"
          emptyDescription={media === "gfa"
            ? "GFA 업로드 화면에서 해당 날짜의 RAW 파일을 올려 주세요."
            : "기간을 바꾸거나, 수집 이력에서 해당 날짜를 수집해 주세요."}
          toolbar={
            <>
              <div className="flex items-center rounded-md border border-line bg-surface-sunken p-0.5" role="tablist">
                {LEVELS.map((lv) => (
                  <button
                    key={lv}
                    role="tab"
                    aria-selected={level === lv}
                    onClick={() => {
                      setLevel(lv);
                      if (lv === "campaign") { setCampaign(null); setAdgroup(null); }
                      if (lv === "adgroup") setAdgroup(null);
                    }}
                    className={cn(
                      "rounded px-3 py-1 text-xs font-medium transition-colors",
                      level === lv ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                    )}
                  >
                    {LEVEL_LABEL[lv]}별
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-ink-faint" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`${LEVEL_LABEL[level]} 이름·ID 검색`}
                  className="h-8 w-56 pl-7 text-xs"
                />
              </div>
              <span className="text-2xs text-ink-faint">
                {level !== "creative" ? "행을 누르면 하위 단위로 들어갑니다" : ""}
              </span>
            </>
          }
        />
      </div>

      <div className="mt-4">
        <CostRevenueChart
          title={`${LEVEL_LABEL[level]}별 광고비 대비 구매완료 매출 (광고비 TOP 10)`}
          description={level !== "creative" ? "막대를 누르면 하위 단위로 들어갑니다" : undefined}
          data={top10}
          loading={breakdown.isLoading}
          onSelect={level === "creative" ? undefined : (d) => {
            const hit = top10.find((t) => t.name === d.name);
            if (hit) drill(hit.row);
          }}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <DailyTrendChart data={daily.data ?? []} metric="cost" title="일별 광고비" format="won" loading={daily.isLoading} />
        <DailyTrendChart data={daily.data ?? []} metric="conv_revenue" title="일별 구매완료 매출" format="won" loading={daily.isLoading} />
        <DailyTrendChart data={daily.data ?? []} metric="conv_roas" title="일별 구매완료 ROAS" format="roas" loading={daily.isLoading} />
        <DailyTrendChart data={daily.data ?? []} metric="clicks" title="일별 클릭수" loading={daily.isLoading} />
      </div>

      <p className="mt-4 text-2xs text-ink-faint">
        CTR = 클릭수 ÷ 노출수 · CPC = 광고비 ÷ 클릭수 · ROAS = 전환매출 ÷ 광고비.
        모든 비율은 합산값으로 다시 계산합니다
        {media === "sa" ? " · 평균 순위는 노출수 가중평균입니다." : "."}
      </p>
    </>
  );
}
