import { createClient } from "@supabase/supabase-js";
import type {
  AdAccount, BreakdownRow, DailyPoint, Level, Media, PeriodSummary, Profile, RawRow, SyncLog, View,
} from "./types";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

if (!isConfigured) {
  // 설정이 없으면 화면에서 안내한다. 여기서 throw 하면 빈 화면만 남는다.
  console.warn("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 설정되지 않았습니다.");
}

export const supabase = createClient(url ?? "http://localhost", anonKey ?? "public-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true },
});

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export interface Scope {
  account: string;
  media: View;
  from: string;
  to: string;
  campaignId?: string | null;
  adgroupId?: string | null;
}

const scopeArgs = (s: Scope) => ({
  p_account: s.account,
  p_media: s.media,
  p_from: s.from,
  p_to: s.to,
  p_campaign: s.campaignId ?? null,
  p_adgroup: s.adgroupId ?? null,
});

/** PostgREST 는 한 번에 최대 1000행 → 그 이상은 나눠서 받는다 */
async function fetchAllRpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const size = 1000;
  const out: T[] = [];
  for (let page = 0; page < 50; page++) {
    const rows = unwrap<T[]>(await supabase.rpc(fn, args).range(page * size, page * size + size - 1));
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

export const api = {
  // -------------------------------------------------------------------------
  // 계정 / 프로필
  // -------------------------------------------------------------------------
  async getProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  async listAccounts(): Promise<AdAccount[]> {
    return unwrap(await supabase.from("ad_accounts").select("*").eq("is_active", true).order("created_at"));
  },

  // -------------------------------------------------------------------------
  // 집계
  // -------------------------------------------------------------------------
  async summary(s: Scope): Promise<PeriodSummary> {
    const rows = unwrap<PeriodSummary[]>(await supabase.rpc("fn_summary", scopeArgs(s)));
    return rows[0];
  },

  async daily(s: Scope): Promise<DailyPoint[]> {
    return unwrap(await supabase.rpc("fn_daily", scopeArgs(s)));
  },

  async breakdown(s: Scope & { level: Level }): Promise<BreakdownRow[]> {
    return fetchAllRpc<BreakdownRow>("fn_breakdown", { ...scopeArgs(s), p_level: s.level });
  },

  // -------------------------------------------------------------------------
  // RAW
  // -------------------------------------------------------------------------
  async rawRows(params: {
    account: string; media: View; from: string; to: string; search?: string;
    page?: number; pageSize?: number;
  }): Promise<{ rows: RawRow[]; total: number }> {
    const page = params.page ?? 0;
    const size = params.pageSize ?? 100;
    let q = supabase.from("v_performance")
      .select("*", { count: "exact" })
      .eq("ad_account_id", params.account)
      .gte("stat_date", params.from).lte("stat_date", params.to)
      .order("stat_date", { ascending: false }).order("cost", { ascending: false })
      .range(page * size, page * size + size - 1);
    if (params.media !== "total") q = q.eq("media", params.media);
    if (params.search) {
      const s = params.search.replace(/[,()]/g, " ");
      q = q.or([
        `campaign_name.ilike.%${s}%`, `adgroup_name.ilike.%${s}%`, `creative_name.ilike.%${s}%`,
        `campaign_id.ilike.%${s}%`, `adgroup_id.ilike.%${s}%`, `creative_id.ilike.%${s}%`,
      ].join(","));
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as RawRow[], total: count ?? 0 };
  },

  /** RAW 전체(엑셀용) — 1000행씩 나눠 받는다 */
  async rawAll(params: { account: string; media: View; from: string; to: string }): Promise<RawRow[]> {
    const out: RawRow[] = [];
    for (let page = 0; page < 100; page++) {
      const { rows } = await api.rawRows({ ...params, page, pageSize: 1000 });
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  },

  // -------------------------------------------------------------------------
  // GFA 데이터 관리
  // -------------------------------------------------------------------------
  /** 날짜별 GFA 적재 현황 */
  async mediaDates(account: string, media: Media, from: string, to: string): Promise<Array<{
    stat_date: string; row_count: number; cost: number; impressions: number; uploaded_at: string;
  }>> {
    return unwrap(await supabase.rpc("fn_media_dates", {
      p_account: account, p_media: media, p_from: from, p_to: to,
    }));
  },

  /** 기간의 GFA 데이터를 지운다. 지운 행 수를 돌려준다. */
  async deleteGfa(account: string, from: string, to: string): Promise<number> {
    const { error, count } = await supabase.from("ad_performance_daily")
      .delete({ count: "exact" })
      .eq("ad_account_id", account).eq("media", "gfa")
      .gte("stat_date", from).lte("stat_date", to);
    if (error) throw new Error(error.message);
    return count ?? 0;
  },

  // -------------------------------------------------------------------------
  // 수집
  // -------------------------------------------------------------------------
  async syncLogs(account: string, limit = 30): Promise<SyncLog[]> {
    return unwrap(await supabase.from("sync_logs").select("*")
      .eq("ad_account_id", account)
      .order("started_at", { ascending: false }).limit(limit));
  },

  async triggerSync(params: { account: string; date?: string }) {
    const { data, error } = await supabase.functions.invoke("sync-ads", {
      body: { accountId: params.account, date: params.date, mode: "manual" },
    });
    if (error) throw new Error(error.message);
    return data as { ok: boolean; upserted?: number; error?: string; nameError?: string | null };
  },
};
