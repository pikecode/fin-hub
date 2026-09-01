"use client";

import { Alert, Button, Card, Descriptions, Form, List, Modal, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import type { Ledger, LedgerCloseCheck, LedgerCreate, Store } from "@fin-hub/shared-types";
import { formatPeriod } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

const periodOptions = Array.from({ length: 12 }, (_, index) => {
  const month = String(index + 1).padStart(2, "0");
  return { label: `2026 年 ${month} 月`, value: `2026-${month}` };
});

export default function LedgersPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [closePreview, setClosePreview] = useState<{ ledger: Ledger; check: LedgerCloseCheck } | null>(null);
  const [form] = Form.useForm<LedgerCreate>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const moneyFormatter = useMemo(
    () =>
      new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "CNY",
        minimumFractionDigits: 2,
      }),
    [],
  );

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载账套");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function submitLedger(values: LedgerCreate) {
    setIsLoading(true);
    try {
      await apiClient.ledgers.create(values);
      setIsModalOpen(false);
      form.resetFields();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法创建账套");
    } finally {
      setIsLoading(false);
    }
  }

  async function changeStatus(ledger: Ledger) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (ledger.status === "closed") {
        await apiClient.ledgers.reopen(ledger.id, "admin");
        await loadData();
      } else {
        const closeCheck = await apiClient.ledgers.closeCheck(ledger.id);
        setClosePreview({ ledger, check: closeCheck });
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新账套状态");
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmCloseLedger() {
    if (!closePreview || !closePreview.check.can_close) {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.ledgers.close(closePreview.ledger.id, "admin");
      setClosePreview(null);
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法封账");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<Ledger> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "period", render: (value: string) => formatPeriod(value) },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: Ledger["status"]) =>
        value === "closed" ? <Tag color="green">已封账</Tag> : <Tag color="gold">打开</Tag>,
    },
    { title: "版本", dataIndex: "version" },
    {
      title: "操作",
      render: (_, record) => (
        <Button type="link" onClick={() => changeStatus(record)}>
          {record.status === "closed" ? "重开" : "封账"}
        </Button>
      ),
    },
  ];

  return (
    <AppShell
      title="门店账套"
      action={<Button type="primary" onClick={() => setIsModalOpen(true)}>新建账套</Button>}
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="账套列表">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={ledgers} />
      </Card>
      <Modal
        title="新建账套"
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitLedger}>
          <Form.Item name="store_id" label="门店" rules={[{ required: true }]}>
            <Select options={stores.map((store) => ({ label: store.name, value: store.id }))} />
          </Form.Item>
          <Form.Item name="period" label="账期" rules={[{ required: true }]}>
            <Select options={periodOptions} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="封账预检"
        open={Boolean(closePreview)}
        onCancel={() => setClosePreview(null)}
        onOk={confirmCloseLedger}
        okButtonProps={{ disabled: !closePreview?.check.can_close }}
        okText={closePreview?.check.can_close ? "确认封账" : "暂不能封账"}
        cancelText="关闭"
        confirmLoading={isLoading}
      >
        {closePreview ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="门店">
                {storesById.get(closePreview.ledger.store_id)?.name ?? "未知门店"}
              </Descriptions.Item>
              <Descriptions.Item label="账期">{formatPeriod(closePreview.ledger.period)}</Descriptions.Item>
              <Descriptions.Item label="未付款支出">{closePreview.check.unpaid_expense_count}</Descriptions.Item>
              <Descriptions.Item label="未匹配流水">
                {closePreview.check.unmatched_bank_transaction_count}
              </Descriptions.Item>
              <Descriptions.Item label="营业收入记录">{closePreview.check.revenue_record_count}</Descriptions.Item>
              <Descriptions.Item label="未对账收入">
                {closePreview.check.unmatched_revenue_record_count}
              </Descriptions.Item>
              <Descriptions.Item label="未对账实收金额" span={2}>
                {moneyFormatter.format(Number(closePreview.check.unmatched_revenue_amount))}
              </Descriptions.Item>
              <Descriptions.Item label="候选匹配" span={2}>
                {closePreview.check.candidate_match_count}
              </Descriptions.Item>
            </Descriptions>
            {closePreview.check.issues.length ? (
              <Alert
                type="error"
                showIcon
                message="封账阻断项"
                description={<List size="small" dataSource={closePreview.check.issues} renderItem={(item) => <List.Item>{item}</List.Item>} />}
              />
            ) : null}
            {closePreview.check.warnings.length ? (
              <Alert
                type="warning"
                showIcon
                message="封账提示"
                description={<List size="small" dataSource={closePreview.check.warnings} renderItem={(item) => <List.Item>{item}</List.Item>} />}
              />
            ) : null}
            {!closePreview.check.issues.length && !closePreview.check.warnings.length ? (
              <Alert type="success" showIcon message="预检通过，可以封账" />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </AppShell>
  );
}
