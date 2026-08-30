"use client";

import { Button, Space, message } from "antd";
import { PlusOutlined, DeleteOutlined, ExportOutlined, FileTextOutlined, TagOutlined } from "@ant-design/icons";
import { useState, useEffect } from "react";
import { EnterprisePageLayout } from "../components/EnterprisePageLayout";
import { SmartFilterBar } from "../components/SmartFilterBar";
import { EnterpriseTable } from "../components/EnterpriseTable";
import { MoneyDisplay } from "../components/MoneyDisplay";
import { StatusBadge } from "../components/StatusBadge";
import type { ExpenseItem, Store, Ledger } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";

export default function ExpensesPageV2() {
  const [items, setItems] = useState<ExpenseItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filterValues, setFilterValues] = useState({});
  const [density, setDensity] = useState<"compact" | "default" | "comfortable">("default");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    try {
      const [storesRes, ledgersRes, itemsRes] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
        apiClient.expenseItems.list("?page_size=500"),
      ]);
      setStores(storesRes.items);
      setLedgers(ledgersRes.items);
      setItems(itemsRes.items);
    } catch (error) {
      message.error("加载数据失败");
    } finally {
      setIsLoading(false);
    }
  }

  const columns = [
    {
      key: "storeName",
      title: "门店",
      dataIndex: "store_id",
      width: 150,
      render: (storeId: string) => stores.find((s) => s.id === storeId)?.name || "-",
    },
    {
      key: "description",
      title: "支出描述",
      dataIndex: "description",
      width: 250,
      ellipsis: true,
    },
    {
      key: "amount",
      title: "金额",
      dataIndex: "amount",
      width: 130,
      align: "right" as const,
      render: (value: number) => <MoneyDisplay value={value} colorize />,
    },
    {
      key: "category",
      title: "分类",
      dataIndex: "category_l1",
      width: 120,
      render: (cat: string) => cat || <span style={{ color: "#a3a3a3" }}>未分类</span>,
    },
    {
      key: "supplier",
      title: "供应商",
      dataIndex: "supplier_name",
      width: 150,
      render: (name: string) => name || <span style={{ color: "#a3a3a3" }}>-</span>,
    },
    {
      key: "paymentStatus",
      title: "付款状态",
      dataIndex: "payment_status",
      width: 100,
      render: (status: string) => <StatusBadge status={status} />,
    },
    {
      key: "expenseDate",
      title: "支出日期",
      dataIndex: "expense_date",
      width: 120,
    },
    {
      key: "ledgerPeriod",
      title: "账期",
      dataIndex: "ledger_period",
      width: 100,
    },
    {
      key: "actions",
      title: "操作",
      width: 120,
      render: (record: ExpenseItem) => (
        <Space size={4}>
          <Button type="link" size="small">
            编辑
          </Button>
          <Button type="link" size="small">
            凭证
          </Button>
        </Space>
      ),
    },
  ];

  const filterConfigs = [
    {
      key: "store_id",
      label: "门店",
      type: "select" as const,
      options: stores.map((s) => ({ label: s.name, value: s.id })),
    },
    {
      key: "ledger_period",
      label: "账期",
      type: "select" as const,
      options: Array.from(new Set(ledgers.map((l) => l.period))).map((p) => ({ label: p, value: p })),
    },
    {
      key: "payment_status",
      label: "付款状态",
      type: "select" as const,
      options: [
        { label: "未付款", value: "unpaid" },
        { label: "部分付款", value: "partial_paid" },
        { label: "已付款", value: "paid" },
      ],
    },
    {
      key: "category_l1",
      label: "分类",
      type: "text" as const,
    },
    {
      key: "amount_range",
      label: "金额范围",
      type: "numberRange" as const,
    },
    {
      key: "date_range",
      label: "日期范围",
      type: "dateRange" as const,
    },
  ];

  const batchActions = [
    {
      key: "category",
      label: "批量分类",
      icon: <TagOutlined />,
      onClick: (keys: any[], rows: ExpenseItem[]) => {
        message.info(`选中 ${keys.length} 项进行分类`);
      },
    },
    {
      key: "export",
      label: "批量导出",
      icon: <ExportOutlined />,
      onClick: (keys: any[], rows: ExpenseItem[]) => {
        message.success(`导出 ${keys.length} 条数据`);
      },
    },
    {
      key: "delete",
      label: "批量删除",
      icon: <DeleteOutlined />,
      danger: true,
      onClick: (keys: any[], rows: ExpenseItem[]) => {
        message.warning(`删除 ${keys.length} 项`);
      },
    },
  ];

  return (
    <EnterprisePageLayout
      title="支出明细"
      subtitle="管理所有门店的支出明细和费用分类"
      icon={<FileTextOutlined />}
      breadcrumbs={[
        { title: "首页", href: "/" },
        { title: "业务管理" },
        { title: "支出明细" },
      ]}
      primaryAction={
        <Button type="primary" icon={<PlusOutlined />}>
          新增支出
        </Button>
      }
      secondaryActions={[
        {
          key: "import",
          label: "导入数据",
          onClick: () => message.info("导入"),
        },
        {
          key: "template",
          label: "下载模板",
          onClick: () => message.info("下载模板"),
        },
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        {/* 智能筛选器 */}
        <SmartFilterBar
          filters={filterConfigs}
          value={filterValues}
          onChange={setFilterValues}
          searchable
          collapsible
        />

        {/* 企业级表格 */}
        <EnterpriseTable
          columns={columns}
          dataSource={items.map((item) => ({ ...item, key: item.id }))}
          loading={isLoading}
          batchActions={batchActions}
          density={density}
          onDensityChange={setDensity}
          showDensityToggle
          exportable
          onExport={(format) => message.success(`导出为 ${format}`)}
          showColumnSettings
          fixedColumns={{
            left: ["storeName"],
            right: ["actions"],
          }}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total) => `共 ${total} 条`,
          }}
        />
      </Space>
    </EnterprisePageLayout>
  );
}
