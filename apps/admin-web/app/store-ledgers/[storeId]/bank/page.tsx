"use client";

import { Spin } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useClientSearchParams } from "../../../lib/searchParams";

export default function StoreLedgerBankPage() {
  const params = useParams<{ storeId: string }>();
  const router = useRouter();
  const searchParams = useClientSearchParams();

  useEffect(() => {
    const period = searchParams.get("period");
    const query = new URLSearchParams({ store_id: params.storeId });
    if (period) query.set("ledger_period", period);
    router.replace(`/bank?${query.toString()}`);
  }, [params.storeId, router, searchParams]);

  return <Spin fullscreen tip="正在进入银行流水管理" />;
}
