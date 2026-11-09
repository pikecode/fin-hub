import { clearNavigation } from "./navigation";
import Taro from "@tarojs/taro";
import type {
  CurrentUser,
  StoreLedgerWorkspace,
  BankTransaction,
  BankTransactionBusinessDetail,
  RevenueRecord,
  DividendMonth,
  FinancialReportSupplement,
} from "@fin-hub/shared-types";
declare const __API_BASE_URL__: string;
export const API_BASE_URL = __API_BASE_URL__;
const TOKEN_KEY = "fin_hub_miniapp_token";
export const getShareholderToken = () => Taro.getStorageSync<string>(TOKEN_KEY);
export const setShareholderToken = (token: string) =>
  Taro.setStorageSync(TOKEN_KEY, token);
export const clearShareholderToken = () => {
  Taro.removeStorageSync(TOKEN_KEY);
  clearNavigation();
};
export class MiniappApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, data?: unknown): Promise<T> {
  const r = await Taro.request<{ data: T; detail?: string }>({
    url: API_BASE_URL + "/api/miniapp" + path,
    method: data ? "POST" : "GET",
    data,
    header: { authorization: "Bearer " + getShareholderToken() },
    timeout: 30000,
  });
  if (r.statusCode === 401 && path != "/login") {
    clearShareholderToken();
    Taro.reLaunch({ url: "/pages/shareholder-login/index" });
  }
  if (r.statusCode < 200 || r.statusCode >= 300)
    throw new MiniappApiError(
      r.statusCode,
      typeof r.data.detail === "string"
        ? r.data.detail
        : "请求失败，请稍后重试",
    );
  return r.data.data;
}
export interface MobileStore {
  id: string;
  name: string;
}
export interface MobileReport {
  report: StoreLedgerWorkspace;
  supplement: FinancialReportSupplement;
}
export interface MobileRevenue {
  channels: { channel: string; gross: string; net: string; fee: string }[];
  items: RevenueRecord[];
  total: number;
}
export interface MobileBank {
  list: { items: BankTransaction[]; total: number };
  balance: {
    balance_amount?: string;
    current_balance?: string;
    [key: string]: unknown;
  };
}
export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; user: CurrentUser }>("/login", {
      username,
      password,
    }),
  me: () => request<CurrentUser>("/me"),
  stores: () => request<MobileStore[]>("/stores"),
  periods: (id: string) => request<string[]>("/periods?store_id=" + id),
  report: (id: string, period: string) =>
    request<MobileReport>(`/report?store_id=${id}&period=${period}`),
  revenue: (id: string, period: string, page: number) =>
    request<MobileRevenue>(
      `/revenue?store_id=${id}&period=${period}&page=${page}`,
    ),
  bank: (id: string, query: string) =>
    request<MobileBank>(`/bank?store_id=${id}&${query}`),
  bankDetail: (id: string) =>
    request<BankTransactionBusinessDetail>("/bank/" + id),
  dividend: (id: string, period: string) =>
    request<{ history: DividendMonth[]; supplement: FinancialReportSupplement }>(
      `/dividend?store_id=${id}&period=${period}`,
    ),
  preopening: (id: string) =>
    request<{
      total: string;
      status: string;
      details: {
        id: string;
        description: string;
        amount: string;
        category_l1: string;
        category_l2: string;
      }[];
    }>("/preopening?store_id=" + id),
  changePassword: (current_password: string, new_password: string) =>
    request("/change-password", { current_password, new_password }),
};
