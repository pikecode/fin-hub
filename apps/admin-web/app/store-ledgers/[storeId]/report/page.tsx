"use client";

import { Alert, Card } from "antd";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import type { StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { AppShell } from "../../../components/AppShell";
import { StoreFinancialReportView } from "../../../components/StoreFinancialReportView";
import { StoreLedgerWorkspaceNav } from "../../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../../lib/api";
import { useClientSearchParams } from "../../../lib/searchParams";

export default function StoreFinancialReportPage() {
  const params = useParams<{ storeId: string }>();
  const searchParams = useClientSearchParams();
  const storeId = params.storeId;
  const period = searchParams.get("period") ?? searchParams.get("ledger_period") ?? dayjs().format("YYYY-MM");
  const [workspace, setWorkspace] = useState<StoreLedgerWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    apiClient.storeLedgers.workspace(storeId, period ? `?period=${encodeURIComponent(period)}` : "")
      .then((data) => {
        if (!ignore) setWorkspace(data);
      })
      .catch((reason) => {
        if (!ignore) setError(reason instanceof Error ? reason.message : "门店信息加载失败");
      });
    return () => {
      ignore = true;
    };
  }, [period, storeId]);

  const periodOptions = useMemo(() => {
    const values = new Set([period, ...(workspace?.ledgers ?? []).map((ledger) => ledger.period)]);
    return [...values].filter(Boolean).sort().reverse().map((value) => ({ label: value, value }));
  }, [period, workspace]);

  return (
    <AppShell title="门店财务报表" kicker="当前门店收入、成本、利润与费用分类">
      {error ? <Alert type="error" showIcon message="门店信息加载失败" description={error} /> : null}
      {workspace ? <StoreLedgerWorkspaceNav storeId={storeId} storeName={workspace.store.name} period={period} periodOptions={periodOptions} activeKey="report" hideStoreSelector /> : <Card loading style={{ marginBottom: 16 }} />}
      <StoreFinancialReportView storeId={storeId} period={period} />
    </AppShell>
  );
}
