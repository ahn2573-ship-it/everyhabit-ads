import type { AdAdapter, FetchParams, NameBook, NormalizedRow } from "./types.ts";
import { campaignTypeOf, seoulDate, toNumber } from "./mapper.ts";

// ---------------------------------------------------------------------------
// Mock 어댑터 — API 키 없이 전체 흐름을 시험해 볼 때 사용 (AD_API_MODE=mock)
// ---------------------------------------------------------------------------
function seededRandom(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_TREE = [
  { c: "cmp-a001-02-000000000000001", g: ["grp-a001-02-000000000000011", "grp-a001-02-000000000000012"] },
  { c: "cmp-a001-01-000000000000002", g: ["grp-a001-01-000000000000021"] },
];

export class MockAdapter implements AdAdapter {
  name = "mock";

  fetchDaily({ statDate }: FetchParams): Promise<NormalizedRow[]> {
    const rnd = seededRandom(statDate);
    const rows: NormalizedRow[] = [];
    for (const { c, g } of MOCK_TREE) {
      for (const grp of g) {
        for (let i = 1; i <= 3; i++) {
          const impressions = Math.floor(rnd() * 800) + 5;
          const clicks = Math.floor(impressions * rnd() * 0.06);
          const cost = clicks * (Math.floor(rnd() * 1500) + 300);
          const convCount = clicks > 0 && rnd() > 0.6 ? Math.floor(rnd() * 4) : 0;
          const convRevenue = convCount * (Math.floor(rnd() * 60000) + 20000);
          rows.push({
            statDate, campaignId: c, adgroupId: grp,
            creativeId: `nad-${grp.slice(4)}-${i}`,
            campaignType: campaignTypeOf(c),
            impressions, clicks, cost,
            avgRank: Number((rnd() * 4 + 1).toFixed(1)),
            convCount, convRevenue,
            totalConvCount: convCount + Math.floor(rnd() * 3),
            totalConvRevenue: convRevenue + Math.floor(rnd() * 100000),
          });
        }
      }
    }
    return Promise.resolve(rows);
  }

  fetchNames(rows: NormalizedRow[]): Promise<NameBook> {
    const book: NameBook = { campaigns: [], adgroups: [], creatives: [] };
    const seenC = new Set<string>(), seenG = new Set<string>();
    for (const r of rows) {
      if (!seenC.has(r.campaignId)) {
        seenC.add(r.campaignId);
        book.campaigns.push({
          id: r.campaignId,
          name: r.campaignType === "02" ? "[테스트] 쇼핑검색 캠페인" : "[테스트] 파워링크 캠페인",
          campaignType: r.campaignType,
        });
      }
      if (!seenG.has(r.adgroupId)) {
        seenG.add(r.adgroupId);
        book.adgroups.push({ id: r.adgroupId, campaignId: r.campaignId, name: `[테스트] 세트 ${seenG.size}` });
      }
      book.creatives.push({
        id: r.creativeId, adgroupId: r.adgroupId, campaignId: r.campaignId,
        name: `[테스트] 소재 ${r.creativeId.slice(-3)}`,
        productName: r.campaignType === "02" ? `[테스트] 상품 ${r.creativeId.slice(-3)}` : null,
        mallProductId: null,
      });
    }
    return Promise.resolve(book);
  }
}

// ---------------------------------------------------------------------------
// 네이버 검색광고 어댑터 — 대용량 보고서(StatReport) 방식 (초코펫하우스에서 검증된 로직)
//
//   1) POST /stat-reports { reportTp: "AD" }            → 노출·클릭·비용·노출순위
//   2) POST /stat-reports { reportTp: "AD_CONVERSION" } → 전환수·전환매출
//   3) GET  /ncc/campaigns, /ncc/adgroups, /ncc/ads     → 캠페인·세트·소재 이름
//
// 성과는 "캠페인 + 세트 + 소재" 단위로 합산해 저장한다.
// ---------------------------------------------------------------------------
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 동시에 limit 개씩만 실행 */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

type Json = Record<string, unknown>;

export class NaverSearchAdAdapter implements AdAdapter {
  name = "naver_searchad";

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private secretKey: string,
    private customerId: string,
  ) {}

  // 서명에는 쿼리스트링을 뺀 경로만 들어간다.
  private async headers(method: string, path: string) {
    const ts = Date.now().toString();
    const uri = path.split("?")[0];
    const signature = await hmacSha256Base64(this.secretKey, `${ts}.${method}.${uri}`);
    return {
      "X-Timestamp": ts,
      "X-API-KEY": this.apiKey,
      "X-CUSTOMER": String(this.customerId),
      "X-Signature": signature,
      "Content-Type": "application/json; charset=UTF-8",
    };
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: await this.headers(method, path),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`네이버 API ${res.status} (${method} ${path.split("?")[0]}): ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json() as T;
  }

  private async buildReport(reportTp: string, statDate: string, maxWaitSec = 60): Promise<string | null> {
    const created = await this.req<Json>("POST", "/stat-reports", { reportTp, statDt: statDate });
    const reportId = pickId(created);
    if (!reportId) {
      throw new Error(`보고서 ID 를 응답에서 찾지 못함 (${reportTp}). 응답: ${JSON.stringify(created).slice(0, 300)}`);
    }
    const intervalSec = 3;
    const tries = Math.floor(maxWaitSec / intervalSec);
    for (let i = 0; i < tries; i++) {
      await sleep(intervalSec * 1000);
      const meta = await this.req<Json>("GET", `/stat-reports/${reportId}`);
      const st = String(meta.status ?? meta.statTp ?? "").toUpperCase();
      const url = (meta.downloadUrl ?? meta.downloadUri ?? meta.url) as string | undefined;
      if (st === "BUILT" || st === "DONE") return url ?? null;
      if (st === "NONE") return null; // 해당 날짜에 데이터 없음
      if (st === "ERROR" || st === "FAIL") throw new Error(`보고서 생성 실패 (${reportTp}): status=${st}`);
    }
    throw new Error(`보고서 생성 시간 초과 (${reportTp}). 잠시 후 다시 시도하세요.`);
  }

  private async downloadTsv(url: string): Promise<string[][]> {
    const path = url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;
    const res = await fetch(url.startsWith("http") ? url : `${this.baseUrl}${url}`, {
      headers: await this.headers("GET", path),
    });
    if (!res.ok) throw new Error(`보고서 다운로드 실패 ${res.status}`);
    const text = await res.text();
    return text.split("\n").filter((l) => l.trim() !== "").map((l) => l.replace(/\r$/, "").split("\t"));
  }

  async fetchDaily({ statDate }: FetchParams): Promise<NormalizedRow[]> {
    const dateCompact = statDate.replace(/-/g, "");

    // 1) 광고효과보고서(AD)
    //    [0]날짜 [1]광고주 [2]캠페인 [3]광고그룹 [4]키워드 [5]소재 [6]비즈채널
    //    [7]노출영역 [8]디바이스(M/P) [+1]노출 [+2]클릭 [+3]비용 [+4]노출순위합계 …
    //    ★ 순위 필드는 평균이 아니라 "노출순위 합계" → 평균 = Σ순위합계 ÷ Σ노출수
    const adUrl = await this.buildReport("AD", statDate);
    const adRows = adUrl ? await this.downloadTsv(adUrl) : [];

    const perf = new Map<string, {
      adId: string; campaignId: string; adgroupId: string;
      impressions: number; clicks: number; cost: number; rankSum: number; rankImp: number;
    }>();

    for (const cols of adRows) {
      const adIdIdx = cols.findIndex((c) => /^nad-/.test(c));
      if (adIdIdx === -1) continue;
      const rowDate = cols.find((c) => /^\d{8}$/.test(c));
      if (rowDate && rowDate !== dateCompact) continue;

      const adId = cols[adIdIdx];
      const campaignId = cols.find((c) => /^cmp-/.test(c)) ?? "-";
      const adgroupId = cols.find((c) => /^grp-/.test(c)) ?? "-";

      const devIdx = cols.findIndex((c) => c === "M" || c === "P");
      const base = devIdx !== -1 ? devIdx + 1 : adIdIdx + 4;
      const n = (k: number) => toNumber(cols[base + k]);
      const impressions = n(0), clicks = n(1), cost = n(2), adRankSum = n(3);

      const key = `${campaignId}|${adgroupId}|${adId}`;
      const cur = perf.get(key) ??
        { adId, campaignId, adgroupId, impressions: 0, clicks: 0, cost: 0, rankSum: 0, rankImp: 0 };
      cur.impressions += impressions;
      cur.clicks += clicks;
      cur.cost += cost;
      if (impressions > 0 && adRankSum > 0) { cur.rankSum += adRankSum; cur.rankImp += impressions; }
      perf.set(key, cur);
    }

    // 2) 광고전환보고서(AD_CONVERSION) — 구매완료만 따로, 총 전환은 전체 유형 합산
    const conv = new Map<string, {
      campaignId: string; adgroupId: string;
      convCount: number; convRevenue: number; totalCount: number; totalRevenue: number;
    }>();
    try {
      const convUrl = await this.buildReport("AD_CONVERSION", statDate, 45);
      if (convUrl) {
        for (const cols of await this.downloadTsv(convUrl)) {
          const adId = cols.find((c) => /^nad-/.test(c));
          if (!adId) continue;
          const rowDate = cols.find((c) => /^\d{8}$/.test(c));
          if (rowDate && rowDate !== dateCompact) continue;

          const typeIdx = cols.findIndex((c) => /^[a-z_]+$/i.test(c) && c !== "M" && c !== "P");
          let cnt = 0, revenue = 0, convType = "";
          if (typeIdx !== -1) {
            convType = cols[typeIdx].toLowerCase();
            cnt = toNumber(cols[typeIdx + 1]);
            revenue = toNumber(cols[typeIdx + 2]);
          }
          const cur = conv.get(adId) ?? {
            campaignId: cols.find((c) => /^cmp-/.test(c)) ?? "-",
            adgroupId: cols.find((c) => /^grp-/.test(c)) ?? "-",
            convCount: 0, convRevenue: 0, totalCount: 0, totalRevenue: 0,
          };
          cur.totalCount += cnt;
          cur.totalRevenue += revenue;
          if (convType.includes("purchase") || convType.includes("pcsale") || convType.includes("buy")) {
            cur.convCount += cnt;
            cur.convRevenue += revenue;
          }
          conv.set(adId, cur);
        }
      }
    } catch (e) {
      console.log("[수집] 전환보고서 건너뜀:", e instanceof Error ? e.message : String(e));
    }

    // 3) 전환은 소재 단위라, 그 소재의 노출 최다 행에만 한 번 붙인다 (중복 방지).
    const topKeyByAd = new Map<string, { key: string; imp: number }>();
    for (const [key, p] of perf) {
      const t = topKeyByAd.get(p.adId);
      if (!t || p.impressions > t.imp) topKeyByAd.set(p.adId, { key, imp: p.impressions });
    }

    const out: NormalizedRow[] = [];
    for (const [key, p] of perf) {
      const c = topKeyByAd.get(p.adId)?.key === key ? conv.get(p.adId) : undefined;
      out.push({
        statDate,
        campaignId: p.campaignId,
        adgroupId: p.adgroupId,
        creativeId: p.adId,
        campaignType: campaignTypeOf(p.campaignId),
        impressions: p.impressions,
        clicks: p.clicks,
        cost: p.cost,
        avgRank: p.rankImp > 0 ? p.rankSum / p.rankImp : null,
        convCount: c?.convCount ?? 0,
        convRevenue: c?.convRevenue ?? 0,
        totalConvCount: c?.totalCount ?? 0,
        totalConvRevenue: c?.totalRevenue ?? 0,
      });
    }
    // 그날 노출은 없고 전환만 잡힌 소재도 빠뜨리지 않는다.
    for (const [adId, c] of conv) {
      if (topKeyByAd.has(adId)) continue;
      out.push({
        statDate, campaignId: c.campaignId, adgroupId: c.adgroupId, creativeId: adId,
        campaignType: campaignTypeOf(c.campaignId),
        impressions: 0, clicks: 0, cost: 0, avgRank: null,
        convCount: c.convCount, convRevenue: c.convRevenue,
        totalConvCount: c.totalCount, totalConvRevenue: c.totalRevenue,
      });
    }
    console.log(`[수집] ${statDate} 소재 ${out.length}건 (전환 소재 ${conv.size})`);
    return out;
  }

  async fetchNames(rows: NormalizedRow[]): Promise<NameBook> {
    const book: NameBook = { campaigns: [], adgroups: [], creatives: [] };
    const deadline = Date.now() + 30_000; // 이름 조회는 최대 30초까지만
    const campaignIds = [...new Set(rows.map((r) => r.campaignId))].filter((x) => x !== "-");
    const adgroupIds = [...new Set(rows.map((r) => r.adgroupId))].filter((x) => x !== "-");

    // 캠페인 (한 번에 전체)
    try {
      const list = await this.req<Json[]>("GET", "/ncc/campaigns");
      for (const c of list ?? []) {
        const id = String(c.nccCampaignId ?? "");
        if (!id) continue;
        book.campaigns.push({ id, name: str(c.name), campaignType: campaignTypeOf(id) });
      }
    } catch (e) {
      console.log("[이름] 캠페인 조회 실패:", e instanceof Error ? e.message : String(e));
    }

    // 세트 (캠페인별)
    await pool(campaignIds, 4, async (cid) => {
      if (Date.now() > deadline) return;
      try {
        const list = await this.req<Json[]>("GET", `/ncc/adgroups?nccCampaignId=${encodeURIComponent(cid)}`);
        for (const g of list ?? []) {
          const id = String(g.nccAdgroupId ?? "");
          if (id) book.adgroups.push({ id, campaignId: str(g.nccCampaignId) ?? cid, name: str(g.name) });
        }
      } catch (e) {
        console.log("[이름] 세트 조회 실패:", cid, e instanceof Error ? e.message : String(e));
      }
    });

    // 소재 (세트별)
    await pool(adgroupIds.slice(0, 400), 4, async (gid) => {
      if (Date.now() > deadline) return;
      try {
        const list = await this.req<Json[]>("GET", `/ncc/ads?nccAdgroupId=${encodeURIComponent(gid)}`);
        for (const a of list ?? []) {
          const id = String(a.nccAdId ?? "");
          if (!id) continue;
          const info = adInfo(a);
          book.creatives.push({
            id, adgroupId: str(a.nccAdgroupId) ?? gid, campaignId: null,
            name: info.name, productName: info.productName, mallProductId: info.mallProductId,
          });
        }
      } catch (e) {
        console.log("[이름] 소재 조회 실패:", gid, e instanceof Error ? e.message : String(e));
      }
    });

    return book;
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function asObj(v: unknown): Json {
  if (!v) return {};
  if (typeof v === "string") {
    try { return JSON.parse(v) as Json; } catch { return {}; }
  }
  return typeof v === "object" ? v as Json : {};
}

/** 소재 객체에서 화면에 보일 이름을 고른다. 쇼핑 소재는 상품명, 텍스트 소재는 제목. */
function adInfo(a: Json): { name: string | null; productName: string | null; mallProductId: string | null } {
  const ref = asObj(a.referenceData);
  const ad = asObj(a.ad);
  const attr = asObj(a.adAttr);
  const productName = str(ref.productName) ?? str(ref.productTitle) ?? str(attr.productName) ??
    str(ad.productName);
  const name = productName ?? str(ad.headline) ?? str(ad.title) ?? str(ad.subject) ??
    str(a.name) ?? str(ad.description);
  const mallProductId = str(ref.mallProductId) ?? str(ref.productId) ?? str(a.referenceKey);
  return { name, productName, mallProductId };
}

function pickId(obj: Json): string | null {
  for (const k of ["reportJobId", "id", "statReportJobId", "jobId", "reportId"]) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
  }
  return null;
}

export function createAdapter(env: Record<string, string | undefined>): AdAdapter {
  const mode = (env.AD_API_MODE ?? "mock").toLowerCase();
  if (mode === "mock") return new MockAdapter();

  const { AD_API_KEY, AD_API_SECRET, AD_API_CUSTOMER_ID } = env;
  // 기본 주소는 https://api.naver.com (예전 값 api.searchad.naver.com 도 그대로 동작)
  const baseUrl = env.AD_API_BASE_URL || "https://api.naver.com";
  if (!AD_API_KEY || !AD_API_SECRET || !AD_API_CUSTOMER_ID) {
    throw new Error("AD_API_MODE=live 인데 AD_API_KEY / AD_API_SECRET / AD_API_CUSTOMER_ID 가 비어 있습니다.");
  }
  return new NaverSearchAdAdapter(baseUrl, AD_API_KEY, AD_API_SECRET, AD_API_CUSTOMER_ID);
}

export { seoulDate };
