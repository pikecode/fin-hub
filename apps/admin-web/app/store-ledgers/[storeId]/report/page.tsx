"use client";

import { Alert, Card } from "antd";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { AppShell } from "../../../components/AppShell";
import { StoreFinancialReportView } from "../../../components/StoreFinancialReportView";
import { StoreLedgerWorkspaceNav } from "../../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../../lib/api";
import { getMyStores, getStoreLedgers } from "../../../lib/referenceData";
import { useClientSearchParams } from "../../../lib/searchParams";

export default function StoreFinancialReportPage() {
  const params = useParams<{ storeId: string }>();
  const searchParams = useClientSearchParams();
  const storeId = params.storeId;
  const period = searchParams.get("period") ?? searchParams.get("ledger_period") ?? dayjs().format("YYYY-MM");
  const [storeName, setStoreName] = useState<string>();
  const [workspacePeriods, setWorkspacePeriods] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    Promise.all([getMyStores(), getStoreLedgers(storeId)])
      .then(([stores, ledgers]) => {
        if (ignore) return;
        setStoreName(stores.find((store) => store.id === storeId)?.name);
        setWorkspacePeriods(ledgers.map((ledger) => ledger.period));
      })
      .catch((reason) => {
        if (!ignore) setError(reason instanceof Error ? reason.message : "门店信息加载失败");
      });
    return () => {
      ignore = true;
    };
  }, [storeId]);

  const periodOptions = useMemo(() => {
    const values = new Set([period, ...workspacePeriods]);
    return [...values].filter(Boolean).sort().reverse().map((value) => ({ label: value, value }));
  }, [period, workspacePeriods]);

  return (
    <AppShell title="门店财务报表" kicker="当前门店收入、成本、利润与费用分类">
      {error ? <Alert type="error" showIcon message="门店信息加载失败" description={error} /> : null}
      {storeName ? <StoreLedgerWorkspaceNav storeId={storeId} storeName={storeName} period={period} periodOptions={periodOptions} activeKey="report" /> : <Card loading style={{ marginBottom: 16 }} />}
      <StoreFinancialReportView storeId={storeId} period={period} />
    </AppShell>
  );
}
