"use client";

import { Spin } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useClientSearchParams } from "../../../lib/searchParams";

export default function StoreLedgerMatchingPage() {
  const params = useParams<{ storeId: string }>();
  const router = useRouter();
  const searchParams = useClientSearchParams();

  useEffect(() => {
    const query = new URLSearchParams({ store_id: params.storeId });
    const period = searchParams.get("period");
    if (period) query.set("ledger_period", period);
    router.replace(`/finance/reconciliation?${query.toString()}`);
  }, [params.storeId, router, searchParams]);

  return <Spin fullscreen tip="正在进入对账管理" />;
}
