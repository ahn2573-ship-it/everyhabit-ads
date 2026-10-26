import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/supabase";
import { resolveRange, type CompareMode, type DateRange } from "@/lib/dateRange";
import type { AdAccount, View } from "@/lib/types";

interface AppStateValue {
  accounts: AdAccount[];
  accountId: string | null;
  setAccountId: (id: string) => void;
  range: DateRange;
  setRange: (r: DateRange) => void;
  compare: CompareMode;
  setCompare: (c: CompareMode) => void;
  media: View;
  setMedia: (m: View) => void;
  loading: boolean;
  error: unknown;
}

const AppStateContext = createContext<AppStateValue | null>(null);
const STORAGE_KEY = "everyhabit-ads.filters";

function loadSaved(): { accountId?: string; range?: DateRange; compare?: CompareMode; media?: View } {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const saved = loadSaved();
  const [accountId, setAccountId] = useState<string | null>(saved.accountId ?? null);
  const [range, setRange] = useState<DateRange>(saved.range ?? resolveRange("last7"));
  const [compare, setCompare] = useState<CompareMode>(saved.compare ?? "prev_period");
  const [media, setMedia] = useState<View>(
    saved.media === "sa" || saved.media === "gfa" ? saved.media : "total",
  );
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });

  useEffect(() => {
    const list = accountsQuery.data ?? [];
    if (list.length && (!accountId || !list.some((a) => a.id === accountId))) setAccountId(list[0].id);
  }, [accountsQuery.data, accountId]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ accountId, range, compare, media }));
    } catch {
      // 저장 못 해도 화면은 정상 동작
    }
  }, [accountId, range, compare, media]);

  const value = useMemo<AppStateValue>(() => ({
    accounts: accountsQuery.data ?? [],
    accountId,
    setAccountId,
    range,
    setRange,
    compare,
    setCompare,
    media,
    setMedia,
    loading: accountsQuery.isLoading,
    error: accountsQuery.error,
  }), [accountsQuery.data, accountsQuery.isLoading, accountsQuery.error, accountId, range, compare, media]);

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState 는 AppStateProvider 안에서만 쓸 수 있습니다.");
  return ctx;
}
