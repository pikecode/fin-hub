"use client";

import type { ApprovalTemplate, ExpenseCategory, Ledger, RevenueChannel, Store } from "@fin-hub/shared-types";
import { apiClient } from "./api";

const TTL_MS = 60_000;

interface CacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string, loader: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) return entry.promise as Promise<T>;
  const promise = loader().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: now + ttlMs, promise });
  return promise;
}

export function clearReferenceDataCache() {
  cache.clear();
}

export function getStores() {
  return cached<Store[]>("stores", async () => {
    const page = await apiClient.stores.list("?page_size=500");
    return page.items;
  });
}

export function getMyStores() {
  return cached<Store[]>("my-stores", () => apiClient.auth.myStores());
}

export function getLedgers(pageSize = 500) {
  return cached<Ledger[]>(`ledgers:${pageSize}`, async () => {
    const page = await apiClient.ledgers.list(`?page_size=${pageSize}`);
    return page.items;
  });
}

export function getStoreLedgers(storeId: string, pageSize = 200) {
  return cached<Ledger[]>(`ledgers:${storeId}:${pageSize}`, async () => {
    const page = await apiClient.ledgers.list(`?store_id=${encodeURIComponent(storeId)}&page_size=${pageSize}`);
    return page.items;
  });
}

export function getRevenueChannels() {
  return cached<RevenueChannel[]>("revenue-channels", async () => {
    const page = await apiClient.revenueChannels.list("?page_size=200");
    return page.items;
  });
}

export function getApprovalTemplates(pageSize = 200) {
  return cached<ApprovalTemplate[]>(`approval-templates:${pageSize}`, async () => {
    const page = await apiClient.dingtalk.listTemplates(`?page_size=${pageSize}`);
    return page.items;
  });
}

export function getExpenseCategories() {
  return cached<ExpenseCategory[]>("expense-categories", async () => {
    const page = await apiClient.categories.list("?page_size=500");
    return page.items;
  });
}
