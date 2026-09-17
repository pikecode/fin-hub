"use client";

import { useParams } from "next/navigation";
import { DividendPageContent } from "../../../components/DividendPageContent";

export default function StoreDividendPage() {
  const params = useParams<{ storeId: string }>();
  return <DividendPageContent embeddedStoreId={params.storeId} />;
}
