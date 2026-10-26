import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload } from "lucide-react";
import { useAppState } from "@/hooks/useAppState";
import { api, supabase } from "@/lib/supabase";
import { mergeFiles, parseGfaFile, type GfaLevel, type GfaParsedRow } from "@/lib/gfa";
import { addDays, seoulToday } from "@/lib/dateRange";
import { num, won } from "@/lib/format";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button, Card, CardHeader, EmptyState, ErrorState, Input, Modal, TableSkeleton,
} from "@/components/ui";

interface Preview {
  files: Array<{ name: string; level: GfaLevel; rows: number; skipped: number }>;
  rows: GfaParsedRow[];
  dates: string[];
  cost: number;
  impressions: number;
  campaigns: number;
  adgroups: number;
  creatives: number;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function dateLabel(dates: string[]) {
  if (!dates.length) return "";
  if (dates.length === 1) return dates[0];
  return `${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length}일)`;
}

export function GfaUpload() {
  const { accountId } = useAppState();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replace, setReplace] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // 삭제
  const [delFrom, setDelFrom] = useState(addDays(seoulToday(), -1));
  const [delTo, setDelTo] = useState(addDays(seoulToday(), -1));
  const [confirmDel, setConfirmDel] = useState<{ from: string; to: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const listFrom = addDays(seoulToday(), -90);
  const dates = useQuery({
    queryKey: ["gfa-dates", accountId, listFrom],
    queryFn: () => api.mediaDates(accountId!, "gfa", listFrom, seoulToday()),
    enabled: Boolean(accountId),
  });

  async function readFiles(files: File[]) {
    setParsing(true);
    setMessage(null);
    setPreview(null);
    try {
      const results: GfaParsedRow[][] = [];
      const info: Preview["files"] = [];
      const problems: string[] = [];
      for (const f of files) {
        const res = await parseGfaFile(f);
        if (res.periodTotal) {
          problems.push(`${f.name}: 기간 합계 리포트입니다. GFA 에서 "일별"로 다시 받아 주세요.`);
          continue;
        }
        if (res.missingColumns.length) {
          problems.push(`${f.name}: 필요한 열이 없습니다 — ${res.missingColumns.join(", ")}`);
          continue;
        }
        if (!res.rows.length) {
          problems.push(`${f.name}: 읽을 수 있는 행이 없습니다.`);
          continue;
        }
        results.push(res.rows);
        info.push({ name: f.name, level: res.level, rows: res.rows.length, skipped: res.skipped });
      }
      if (problems.length && !results.length) {
        setMessage({ tone: "bad", text: problems.join("\n") });
        return;
      }
      const rows = mergeFiles(results);
      setPreview({
        files: info,
        rows,
        dates: [...new Set(rows.map((r) => r.stat_date))].sort(),
        cost: rows.reduce((a, r) => a + r.cost, 0),
        impressions: rows.reduce((a, r) => a + r.impressions, 0),
        campaigns: new Set(rows.map((r) => r.campaign_id)).size,
        adgroups: new Set(rows.filter((r) => r.adgroup_id !== "-").map((r) => r.adgroup_id)).size,
        creatives: new Set(rows.filter((r) => r.creative_id !== "-").map((r) => r.creative_id)).size,
      });
      if (problems.length) setMessage({ tone: "bad", text: `일부 파일은 제외했습니다.\n${problems.join("\n")}` });
    } catch (e) {
      setMessage({ tone: "bad", text: e instanceof Error ? e.message : "파일을 읽지 못했습니다." });
    } finally {
      setParsing(false);
    }
  }

  async function save() {
    if (!preview || !accountId) return;
    setSaving(true);
    setMessage(null);
    try {
      const now = new Date().toISOString();
      const { rows } = preview;

      // 1) 이름표 (같은 ID 는 나중 날짜의 이름으로)
      const sorted = [...rows].sort((a, b) => a.stat_date.localeCompare(b.stat_date));
      const camp = new Map<string, Record<string, unknown>>();
      const grp = new Map<string, Record<string, unknown>>();
      const cre = new Map<string, Record<string, unknown>>();
      for (const r of sorted) {
        if (r.campaign_id !== "-") {
          camp.set(r.campaign_id, {
            ad_account_id: accountId, media: "gfa", campaign_id: r.campaign_id,
            name: r.campaign_name, updated_at: now,
          });
        }
        if (r.adgroup_id !== "-") {
          grp.set(r.adgroup_id, {
            ad_account_id: accountId, media: "gfa", adgroup_id: r.adgroup_id,
            campaign_id: r.campaign_id, name: r.adgroup_name, updated_at: now,
          });
        }
        if (r.creative_id !== "-") {
          cre.set(r.creative_id, {
            ad_account_id: accountId, media: "gfa", creative_id: r.creative_id,
            adgroup_id: r.adgroup_id, campaign_id: r.campaign_id, name: r.creative_name, updated_at: now,
          });
        }
      }
      const upsert = async (table: string, onConflict: string, list: Record<string, unknown>[]) => {
        for (const part of chunks(list, 500)) {
          const { error } = await supabase.from(table).upsert(part, { onConflict });
          if (error) throw new Error(`${table}: ${error.message}`);
        }
      };
      await upsert("campaigns", "ad_account_id,media,campaign_id", [...camp.values()]);
      await upsert("adgroups", "ad_account_id,media,adgroup_id", [...grp.values()]);
      await upsert("creatives", "ad_account_id,media,creative_id", [...cre.values()]);

      // 2) 같은 날짜 기존 GFA 데이터 정리 (선택)
      let removed = 0;
      if (replace) {
        for (const part of chunks(preview.dates, 50)) {
          const { error, count } = await supabase.from("ad_performance_daily")
            .delete({ count: "exact" })
            .eq("ad_account_id", accountId).eq("media", "gfa").in("stat_date", part);
          if (error) throw new Error(error.message);
          removed += count ?? 0;
        }
      }

      // 3) 성과 저장
      const payload = rows.map((r) => ({
        ad_account_id: accountId, media: "gfa", stat_date: r.stat_date,
        campaign_id: r.campaign_id, adgroup_id: r.adgroup_id, creative_id: r.creative_id,
        impressions: r.impressions, clicks: r.clicks, cost: r.cost,
        conv_count: r.conv_count, conv_revenue: r.conv_revenue,
        total_conv_count: r.total_conv_count, total_conv_revenue: r.total_conv_revenue,
        cart_count: r.cart_count, cart_revenue: r.cart_revenue,
        source: "gfa_import", updated_at: now,
      }));
      await upsert("ad_performance_daily", "ad_account_id,media,stat_date,campaign_id,adgroup_id,creative_id", payload);

      setMessage({
        tone: "ok",
        text: `${dateLabel(preview.dates)} · ${num(payload.length)}건 반영 · 광고비 ${won(preview.cost)}` +
          (replace ? ` (기존 ${num(removed)}건 교체)` : ""),
      });
      setPreview(null);
      qc.invalidateQueries();
    } catch (e) {
      setMessage({ tone: "bad", text: e instanceof Error ? e.message : "저장에 실패했습니다." });
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!confirmDel || !accountId) return;
    setDeleting(true);
    try {
      const n = await api.deleteGfa(accountId, confirmDel.from, confirmDel.to);
      setMessage({
        tone: "ok",
        text: `${confirmDel.from === confirmDel.to ? confirmDel.from : `${confirmDel.from} ~ ${confirmDel.to}`} GFA 데이터 ${num(n)}건을 삭제했습니다.`,
      });
      qc.invalidateQueries();
    } catch (e) {
      setMessage({ tone: "bad", text: e instanceof Error ? e.message : "삭제에 실패했습니다." });
    } finally {
      setDeleting(false);
      setConfirmDel(null);
    }
  }

  const busy = parsing || saving;

  return (
    <>
      <PageHeader
        title="GFA 업로드"
        description="네이버 GFA 에서 받은 일별 RAW 리포트(CSV · XLSX)를 올립니다"
      />

      {message && (
        <div className={cn(
          "mb-3 whitespace-pre-line rounded-md border px-3 py-2 text-xs",
          message.tone === "ok" ? "border-good/30 bg-good-soft text-good" : "border-bad/30 bg-bad-soft text-bad",
        )}>
          {message.text}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="파일 올리기"
              description="열 이름을 보고 캠페인 · 광고 그룹(세트) · 광고 소재와 지표를 자동으로 찾습니다"
            />
            <div className="px-4 py-4">
              <input
                ref={fileRef} type="file" accept=".csv,.xlsx,.xls" multiple className="hidden"
                onChange={(e) => {
                  const fs = Array.from(e.target.files ?? []);
                  if (fs.length) readFiles(fs);
                  e.target.value = "";
                }}
              />
              <div
                role="button"
                tabIndex={0}
                onClick={() => !busy && fileRef.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (busy) return;
                  const fs = Array.from(e.dataTransfer.files ?? []).filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name));
                  if (fs.length) readFiles(fs);
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors",
                  dragging ? "border-brand-500 bg-brand-50" : "border-line hover:border-brand-500 hover:bg-surface-sunken",
                  busy && "pointer-events-none opacity-60",
                )}
              >
                <Upload className="h-6 w-6 text-ink-faint" />
                <p className="text-sm font-medium">
                  {parsing ? "파일 읽는 중…" : "여기로 파일을 끌어다 놓거나 클릭해서 선택"}
                </p>
                <p className="text-2xs text-ink-faint">여러 날짜 · 여러 파일을 한 번에 올려도 됩니다</p>
              </div>

              <label className="mt-3 flex items-start gap-2 text-xs text-ink-muted">
                <input type="checkbox" className="mt-0.5" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                <span>
                  <b className="text-ink">올리는 날짜의 기존 GFA 데이터를 먼저 지우고 새로 넣기 (권장)</b><br />
                  같은 날짜를 다시 올릴 때 예전 행이 남지 않습니다. 한 날짜를 캠페인별로 나눠 따로따로 올릴 때만 끄세요.
                </span>
              </label>
            </div>
          </Card>

          {preview && (
            <Card>
              <CardHeader title="반영 전 확인" description="숫자가 GFA 화면과 맞는지 확인한 뒤 반영하세요" />
              <div className="grid grid-cols-2 gap-3 px-4 py-4 text-sm md:grid-cols-3">
                <div><p className="text-2xs text-ink-faint">날짜</p><p className="font-medium">{dateLabel(preview.dates)}</p></div>
                <div><p className="text-2xs text-ink-faint">광고비 합계</p><p className="tnum font-medium">{won(preview.cost)}</p></div>
                <div><p className="text-2xs text-ink-faint">노출수 합계</p><p className="tnum font-medium">{num(preview.impressions)}</p></div>
                <div><p className="text-2xs text-ink-faint">캠페인</p><p className="tnum font-medium">{num(preview.campaigns)}개</p></div>
                <div><p className="text-2xs text-ink-faint">세트</p><p className="tnum font-medium">{num(preview.adgroups)}개</p></div>
                <div><p className="text-2xs text-ink-faint">소재</p><p className="tnum font-medium">{num(preview.creatives)}개</p></div>
              </div>
              <ul className="border-t border-line px-4 py-2 text-2xs text-ink-muted">
                {preview.files.map((f) => (
                  <li key={f.name} className="py-0.5">
                    {f.name} — {f.level} 단위 · {num(f.rows)}행{f.skipped ? ` · 건너뜀 ${num(f.skipped)}` : ""}
                    {f.level === "캠페인" && " · 세트/소재 구분 없이 캠페인 단위로만 보입니다"}
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
                <Button onClick={() => setPreview(null)} disabled={saving}>취소</Button>
                <Button variant="primary" onClick={save} loading={saving}>반영하기</Button>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="기간 지정 삭제" description="잘못 올린 GFA 데이터를 날짜 범위로 지웁니다 (SA 데이터는 건드리지 않음)" />
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <Input type="date" value={delFrom} max={seoulToday()}
                onChange={(e) => { setDelFrom(e.target.value); if (e.target.value > delTo) setDelTo(e.target.value); }}
                className="h-8 w-40 text-xs" />
              <span className="text-xs text-ink-faint">~</span>
              <Input type="date" value={delTo} min={delFrom} max={seoulToday()}
                onChange={(e) => setDelTo(e.target.value)} className="h-8 w-40 text-xs" />
              <Button variant="danger" size="sm" onClick={() => setConfirmDel({ from: delFrom, to: delTo })}>
                <Trash2 className="h-3.5 w-3.5" /> 삭제
              </Button>
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <CardHeader title="날짜별 업로드 현황" description="최근 90일" />
          {dates.error ? <ErrorState error={dates.error} onRetry={() => dates.refetch()} /> :
            dates.isLoading ? <TableSkeleton rows={8} cols={4} /> :
            (dates.data ?? []).length === 0 ? (
              <EmptyState title="아직 올린 GFA 데이터가 없습니다" />
            ) : (
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th">날짜</th>
                      <th className="th text-right">행</th>
                      <th className="th text-right">광고비</th>
                      <th className="th">마지막 반영</th>
                      <th className="th" />
                    </tr>
                  </thead>
                  <tbody>
                    {(dates.data ?? []).map((d) => (
                      <tr key={d.stat_date} className="row-hover">
                        <td className="td tnum">{d.stat_date}</td>
                        <td className="td text-right">{num(d.row_count)}</td>
                        <td className="td text-right">{won(d.cost)}</td>
                        <td className="td text-2xs text-ink-faint">
                          {new Date(d.uploaded_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                        </td>
                        <td className="td text-right">
                          <button
                            onClick={() => setConfirmDel({ from: d.stat_date, to: d.stat_date })}
                            className="rounded p-1 text-ink-faint hover:bg-bad-soft hover:text-bad"
                            aria-label={`${d.stat_date} 삭제`}
                            title="이 날짜 삭제"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
      </div>

      <Modal
        open={Boolean(confirmDel)}
        onClose={() => !deleting && setConfirmDel(null)}
        title="GFA 데이터 삭제"
        footer={
          <>
            <Button onClick={() => setConfirmDel(null)} disabled={deleting}>취소</Button>
            <Button variant="danger" onClick={doDelete} loading={deleting}>삭제</Button>
          </>
        }
      >
        <p className="text-sm">
          <b>{confirmDel && (confirmDel.from === confirmDel.to ? confirmDel.from : `${confirmDel.from} ~ ${confirmDel.to}`)}</b>
          {" "}의 GFA 데이터를 모두 삭제합니다. 되돌릴 수 없으니, 지운 뒤 같은 날짜 파일을 다시 올려 주세요.
        </p>
      </Modal>
    </>
  );
}
