import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { useAppState } from "@/hooks/useAppState";
import { api } from "@/lib/supabase";
import { exportRaw } from "@/lib/excel";
import { decimal, num, won } from "@/lib/format";
import { PageHeader } from "@/components/layout/AppShell";
import { PeriodFilter } from "@/components/layout/PeriodFilter";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Pagination, TableSkeleton } from "@/components/ui";
import { MEDIA_LABEL, campaignTypeLabel } from "@/lib/types";

const PAGE_SIZE = 100;

export function RawData() {
  const { accountId, range, media } = useAppState();
  const [page, setPage] = useState(0);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);

  // 검색어는 입력이 멈추고 0.4초 뒤에 반영
  useEffect(() => {
    const t = setTimeout(() => { setSearch(input.trim()); setPage(0); }, 400);
    return () => clearTimeout(t);
  }, [input]);
  useEffect(() => setPage(0), [media, range]);

  const query = useQuery({
    queryKey: ["raw", accountId, media, range, page, search],
    queryFn: () => api.rawRows({
      account: accountId!, media, from: range.from, to: range.to, page, pageSize: PAGE_SIZE, search,
    }),
    enabled: Boolean(accountId),
  });

  async function handleExport() {
    if (!accountId) return;
    setExporting(true);
    try {
      const rows = await api.rawAll({ account: accountId, media, from: range.from, to: range.to });
      exportRaw(media, range.from, range.to, rows);
    } finally {
      setExporting(false);
    }
  }

  const rows = query.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title={`RAW 데이터 · ${MEDIA_LABEL[media]}`}
        description="날짜 · 캠페인 · 세트 · 소재 단위로 저장된 원본 행입니다"
        actions={
          <Button onClick={handleExport} loading={exporting}>
            <Download className="h-3.5 w-3.5" /> 엑셀 다운로드
          </Button>
        }
      />
      <PeriodFilter showCompare={false} />

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-ink-faint" />
            <Input value={input} onChange={(e) => setInput(e.target.value)}
              placeholder="캠페인 · 세트 · 소재 이름이나 ID" className="h-8 w-72 pl-7 text-xs" />
          </div>
        </div>

        {query.error ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.isLoading ? (
          <TableSkeleton rows={10} cols={8} />
        ) : rows.length === 0 ? (
          <EmptyState title="표시할 데이터가 없습니다" description="기간이나 검색어를 바꿔 보세요." />
        ) : (
          <>
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">날짜</th>
                    <th className="th">캠페인</th>
                    <th className="th">세트</th>
                    <th className="th">소재</th>
                    <th className="th text-right">노출수</th>
                    <th className="th text-right">클릭수</th>
                    <th className="th text-right">광고비</th>
                    <th className="th text-right">구매완료 수</th>
                    <th className="th text-right">구매완료 매출</th>
                    <th className="th text-right">총 전환수</th>
                    {media === "sa"
                      ? <th className="th text-right">평균 순위</th>
                      : <th className="th text-right">장바구니 수</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="row-hover">
                      <td className="td tnum whitespace-nowrap">{r.stat_date}</td>
                      <td className="td max-w-[220px]">
                        <p className="truncate" title={r.campaign_name ?? r.campaign_id}>{r.campaign_name ?? r.campaign_id}</p>
                        {media === "sa" && r.campaign_type && <Badge>{campaignTypeLabel(r.campaign_type)}</Badge>}
                      </td>
                      <td className="td max-w-[200px] truncate" title={r.adgroup_name ?? r.adgroup_id}>
                        {r.adgroup_name ?? r.adgroup_id}
                      </td>
                      <td className="td max-w-[260px]">
                        <p className="truncate" title={r.creative_name ?? r.creative_id}>{r.creative_name ?? r.creative_id}</p>
                        {r.creative_id !== "-" && r.creative_id !== r.creative_name && (
                          <p className="truncate font-mono text-[10px] text-ink-faint">{r.creative_id}</p>
                        )}
                      </td>
                      <td className="td text-right">{num(r.impressions)}</td>
                      <td className="td text-right">{num(r.clicks)}</td>
                      <td className="td text-right font-medium">{won(r.cost)}</td>
                      <td className="td text-right">{num(r.conv_count)}</td>
                      <td className="td text-right">{won(r.conv_revenue)}</td>
                      <td className="td text-right">{num(r.total_conv_count)}</td>
                      {media === "sa"
                        ? <td className="td text-right">{r.avg_rank ? decimal(r.avg_rank, 1) : "—"}</td>
                        : <td className="td text-right">{num(r.cart_count)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total ?? 0} onChange={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
