"use client";

import { Alert, Button, Card, Form, Modal, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import type { Ledger, LedgerCreate, Store } from "@fin-hub/shared-types";
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
  const [form] = Form.useForm<LedgerCreate>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);

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
      } else {
        const closeCheck = await apiClient.ledgers.closeCheck(ledger.id);
        if (!closeCheck.can_close) {
          setErrorMessage(`暂不能封账：${closeCheck.issues.join("；")}`);
          return;
        }
        if (closeCheck.warnings.length) {
          setErrorMessage(`封账提示：${closeCheck.warnings.join("；")}`);
        }
        await apiClient.ledgers.close(ledger.id, "admin");
      }
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新账套状态");
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
    </AppShell>
  );
}
