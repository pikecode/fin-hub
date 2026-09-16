"use client";

import { Alert, Button, Card, DatePicker, Empty, Form, Select, Space, Typography } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { Store } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { StoreFinancialReportView } from "../components/StoreFinancialReportView";
import { getStores } from "../lib/referenceData";
import { useClientSearchParams } from "../lib/searchParams";

dayjs.locale("zh-cn");

interface ReportFilterValues {
  store_id?: string;
  period?: dayjs.Dayjs;
}

export default function ReportsPage() {
  const router = useRouter();
  const searchParams = useClientSearchParams();
  const queryStoreId = searchParams.get("store_id") ?? undefined;
  const queryPeriod = searchParams.get("period") ?? searchParams.get("period_start") ?? dayjs().format("YYYY-MM");
  const [stores, setStores] = useState<Store[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isChanging, startChanging] = useTransition();
  const [form] = Form.useForm<ReportFilterValues>();

  const selectedStore = useMemo(() => stores.find((store) => store.id === queryStoreId), [queryStoreId, stores]);

  useEffect(() => {
    let ignore = false;
    getStores()
      .then((items) => {
        if (!ignore) setStores(items);
      })
      .catch((error) => {
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "无法加载门店");
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!isLoading && stores.length > 0 && !queryStoreId) {
      const query = new URLSearchParams({ store_id: stores[0].id, period: queryPeriod });
      router.replace(`/reports?${query.toString()}`);
    }
  }, [isLoading, queryPeriod, queryStoreId, router, stores]);

  useEffect(() => {
    form.setFieldsValue({
      store_id: queryStoreId,
      period: dayjs(`${queryPeriod}-01`),
    });
  }, [form, queryPeriod, queryStoreId]);

  function applyFilters(values: ReportFilterValues) {
    if (!values.store_id || !values.period) return;
    const query = new URLSearchParams({
      store_id: values.store_id,
      period: values.period.format("YYYY-MM"),
    });
    startChanging(() => router.push(`/reports?${query.toString()}`));
  }

  return (
    <AppShell
      title="门店财务报表"
      kicker="按门店和账期查看收入、成本、利润与费用分类"
    >
      {errorMessage ? <Alert message="报表加载失败" description={errorMessage} type="error" showIcon closable onClose={() => setErrorMessage(null)} /> : null}

      <Card className="analytics-filter-card report-filter-card">
        <Space direction="vertical" size={4}>
          <Typography.Text strong>选择报表范围</Typography.Text>
          <Typography.Text type="secondary">报表收入按收入日期统计，支出按入账月份统计。</Typography.Text>
        </Space>
        <Form form={form} layout="inline" onFinish={applyFilters} className="report-filter-form">
          <Form.Item name="store_id" label="门店" rules={[{ required: true, message: "请选择门店" }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={isLoading}
              placeholder="请选择门店"
              style={{ width: 280 }}
              onChange={(storeId: string) => applyFilters({ store_id: storeId, period: form.getFieldValue("period") })}
              options={stores.map((store) => ({ label: store.name, value: store.id }))}
            />
          </Form.Item>
          <Form.Item name="period" label="账期" rules={[{ required: true, message: "请选择账期" }]}>
            <DatePicker picker="month" locale={zhCN.DatePicker} format="YYYY年MM月" allowClear={false} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={isChanging}>查看报表</Button>
          </Form.Item>
        </Form>
      </Card>

      {isLoading ? (
        <Card loading style={{ marginTop: 16, minHeight: 220 }} />
      ) : selectedStore ? (
        <StoreFinancialReportView storeId={selectedStore.id} period={queryPeriod} />
      ) : (
        <Card style={{ marginTop: 16 }}>
          <Empty description="暂无可查看的门店" />
        </Card>
      )}
    </AppShell>
  );
}
