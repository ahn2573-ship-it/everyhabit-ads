// ============================================================================
// sync-ads — 네이버 검색광고(SA) 일별 데이터 수집 Edge Function
//
//  POST /functions/v1/sync-ads
//  body: { "date": "2026-10-21", "accountId": "<uuid>", "mode": "auto" | "manual" }
//
//  · date 생략 시 한국시간 기준 전일
//  · 같은 날짜를 다시 수집하면 그 날짜의 SA 데이터를 새로 받은 값으로 갈아끼운다
//  · API Key / Secret 은 이 함수의 환경변수로만 존재하고 브라우저로 나가지 않는다
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { createAdapter } from "./adapters.ts";
import { dedupeRows, seoulYesterday } from "./mapper.ts";
import type { NameBook, NormalizedRow } from "./types.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const MEDIA = "sa";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const startedAt = Date.now();
  const env = Deno.env.toObject();
  const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  let body: { date?: string; accountId?: string; mode?: string } = {};
  try {
    body = await req.json();
  } catch {
    // 본문 없이 호출해도 기본값으로 동작한다.
  }
  const statDate = body.date ?? seoulYesterday();
  const mode = body.mode ?? "auto";

  const { data: account, error: accountErr } = body.accountId
    ? await supabase.from("ad_accounts").select("*").eq("id", body.accountId).single()
    : await supabase.from("ad_accounts").select("*").eq("is_active", true)
        .order("created_at").limit(1).single();
  if (accountErr || !account) {
    return json({ ok: false, error: "활성화된 광고 계정을 찾지 못했습니다." }, 400);
  }
  const accountId: string = account.id;
  const isLive = (env.AD_API_MODE ?? "mock").toLowerCase() === "live";

  const { data: logRow } = await supabase.from("sync_logs").insert({
    ad_account_id: accountId,
    stat_date: statDate,
    status: "running",
    mode: isLive ? "api" : "mock",
  }).select("id").single();

  const finish = async (patch: Record<string, unknown>) => {
    if (!logRow?.id) return;
    await supabase.from("sync_logs").update({
      ...patch,
      duration_ms: Date.now() - startedAt,
      finished_at: new Date().toISOString(),
    }).eq("id", logRow.id);
  };

  // ---- 1. 성과 수집 (실패 시 재시도) -----------------------------------------
  let rows: NormalizedRow[] = [];
  let attempt = 0;
  let lastError: unknown = null;
  let adapter;
  try {
    adapter = createAdapter(env);
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      try {
        rows = await adapter.fetchDaily({ statDate });
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("시간 초과") || msg.includes("timeout")) break;
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  } catch (e) {
    lastError = e;
  }

  if (lastError || !adapter) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    await finish({ status: "failed", attempt, message });
    return json({ ok: false, error: message, attempt }, 502);
  }

  const deduped = dedupeRows(rows).filter((r) => r.statDate === statDate);

  // ---- 2. 이름표 갱신 (실패해도 성과 저장은 진행) ------------------------------
  let names: NameBook = { campaigns: [], adgroups: [], creatives: [] };
  let nameError: string | null = null;
  try {
    names = await adapter.fetchNames(deduped);
  } catch (e) {
    nameError = e instanceof Error ? e.message : String(e);
  }
  const now = new Date().toISOString();

  // 성과에 나온 세트→캠페인 관계로 소재의 캠페인을 채운다.
  const campaignOfGroup = new Map<string, string>();
  for (const r of deduped) campaignOfGroup.set(r.adgroupId, r.campaignId);
  for (const g of names.adgroups) if (g.campaignId) campaignOfGroup.set(g.id, g.campaignId);

  const upsertNames = async (table: string, onConflict: string, list: Record<string, unknown>[]) => {
    for (const part of chunks(list, 500)) {
      const { error } = await supabase.from(table).upsert(part, { onConflict });
      if (error) nameError = `${table}: ${error.message}`;
    }
  };
  await upsertNames("campaigns", "ad_account_id,media,campaign_id",
    names.campaigns.map((c) => ({
      ad_account_id: accountId, media: MEDIA, campaign_id: c.id,
      name: c.name, campaign_type: c.campaignType, updated_at: now,
    })));
  await upsertNames("adgroups", "ad_account_id,media,adgroup_id",
    names.adgroups.map((g) => ({
      ad_account_id: accountId, media: MEDIA, adgroup_id: g.id,
      campaign_id: g.campaignId, name: g.name, updated_at: now,
    })));
  await upsertNames("creatives", "ad_account_id,media,creative_id",
    names.creatives.map((c) => ({
      ad_account_id: accountId, media: MEDIA, creative_id: c.id,
      adgroup_id: c.adgroupId,
      campaign_id: c.campaignId ?? (c.adgroupId ? campaignOfGroup.get(c.adgroupId) ?? null : null),
      name: c.name, product_name: c.productName, mall_product_id: c.mallProductId, updated_at: now,
    })));

  // ---- 3. 성과 저장: 그 날짜의 SA 행을 지우고 새로 넣는다 ------------------------
  const payload = deduped.map((r) => ({
    ad_account_id: accountId,
    media: MEDIA,
    stat_date: r.statDate,
    campaign_id: r.campaignId || "-",
    adgroup_id: r.adgroupId || "-",
    creative_id: r.creativeId || "-",
    campaign_type: r.campaignType,
    impressions: r.impressions,
    clicks: r.clicks,
    cost: r.cost,
    avg_rank: r.avgRank,
    conv_count: r.convCount,
    conv_revenue: r.convRevenue,
    total_conv_count: r.totalConvCount,
    total_conv_revenue: r.totalConvRevenue,
    source: isLive ? "api" : "mock",
    updated_at: now,
  }));

  const { error: delErr } = await supabase.from("ad_performance_daily")
    .delete()
    .eq("ad_account_id", accountId).eq("media", MEDIA).eq("stat_date", statDate);
  if (delErr) {
    await finish({ status: "failed", attempt, rows_fetched: rows.length, message: delErr.message });
    return json({ ok: false, error: delErr.message }, 500);
  }

  let saved = 0;
  for (const part of chunks(payload, 500)) {
    const { error } = await supabase.from("ad_performance_daily").upsert(part, {
      onConflict: "ad_account_id,media,stat_date,campaign_id,adgroup_id,creative_id",
    });
    if (error) {
      await finish({ status: "failed", attempt, rows_fetched: rows.length, rows_upserted: saved, message: error.message });
      return json({ ok: false, error: error.message }, 500);
    }
    saved += part.length;
  }

  await finish({
    status: nameError ? "partial" : "success",
    attempt,
    rows_fetched: rows.length,
    rows_upserted: saved,
    message: nameError ? `성과는 저장됨 · 이름 갱신 일부 실패: ${nameError}` : null,
    detail: {
      mode, statDate, adapter: adapter.name,
      names: { campaigns: names.campaigns.length, adgroups: names.adgroups.length, creatives: names.creatives.length },
    },
  });

  return json({ ok: true, statDate, fetched: rows.length, upserted: saved, attempt, nameError });
});
