import Taro from "@tarojs/taro";
import type {
  ApiEnvelope,
  LedgerPeriodOption,
  LedgerReportDetail,
  LedgerReportSummary,
  LedgerTrend,
  ReportPeriodOption,
  ShareholderAccessGrant,
  ShareholderLoginResponse,
  StoreComparisonReport,
  StoreReportSummary,
} from "@fin-hub/shared-types";

declare const __API_BASE_URL__: string;

const API_BASE_URL = __API_BASE_URL__;
const TOKEN_KEY = "fin_hub_shareholder_token";

export class MiniappApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function getShareholderToken() {
  return Taro.getStorageSync<string>(TOKEN_KEY);
}

export function setShareholderToken(token: string) {
  Taro.setStorageSync(TOKEN_KEY, token);
}

export function clearShareholderToken() {
  Taro.removeStorageSync(TOKEN_KEY);
}

async function request<T>(path: string, options: { method?: "GET" | "POST"; data?: unknown; auth?: boolean } = {}): Promise<T> {
  const token = getShareholderToken();
  const response = await Taro.request<ApiEnvelope<T>>({
    url: `${API_BASE_URL}${path}`,
    method: options.method ?? "GET",
    data: options.data,
    header: options.auth === false || !token ? undefined : { authorization: `Bearer ${token}` },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new MiniappApiError(response.statusCode, `API ${response.statusCode}`);
  }
  return response.data.data;
}

export const api = {
  login: (accessCode: string) =>
    request<ShareholderLoginResponse>("/api/shareholder-auth/login", {
      method: "POST",
      data: { access_code: accessCode },
      auth: false,
    }),
  storeSummaries: () => request<StoreReportSummary[]>("/api/reports/store-summaries"),
  storeComparison: (period?: string) =>
    request<StoreComparisonReport>(
      `/api/reports/store-comparison${period ? `?period=${encodeURIComponent(period)}` : ""}`,
    ),
  reportPeriods: () => request<ReportPeriodOption[]>("/api/reports/periods"),
  shareholderMe: () => request<ShareholderAccessGrant>("/api/shareholder-auth/me"),
  ledgerPeriods: (storeId: string) =>
    request<LedgerPeriodOption[]>(`/api/reports/ledger-periods?store_id=${encodeURIComponent(storeId)}`),
  ledgerTrends: (storeId?: string, limit = 6) => {
    const params = [`limit=${encodeURIComponent(String(limit))}`];
    if (storeId) params.unshift(`store_id=${encodeURIComponent(storeId)}`);
    return request<LedgerTrend[]>(`/api/reports/ledger-trends?${params.join("&")}`);
  },
  ledgerSummary: (storeId: string, period: string) =>
    request<LedgerReportSummary>(
      `/api/reports/ledger-summary?store_id=${encodeURIComponent(storeId)}&period=${encodeURIComponent(period)}`,
    ),
  ledgerDetail: (storeId: string, period: string) =>
    request<LedgerReportDetail>(
      `/api/reports/ledger-detail?store_id=${encodeURIComponent(storeId)}&period=${encodeURIComponent(period)}`,
    ),
};
