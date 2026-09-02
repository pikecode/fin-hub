"use client";

import {
  Alert,
  Card,
  Empty,
  Space,
  Table,
  Typography,
  Tabs,
  Badge,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  BankOutlined,
  FileTextOutlined,
  WalletOutlined,
  DollarOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  RiseOutlined,
  FallOutlined,
} from "@ant-design/icons";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ApprovalInstance, BankTransaction, RevenueRecord, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { MoneyDisplay } from "../../components/MoneyDisplay";
import { StatusBadge } from "../../components/StatusBadge";
import { getBankTransactionViewColumns } from "../../components/BankTransactionColumns";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { useClientSearchParams } from "../../lib/searchParams";

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

export default function StoreLedgerWorkspacePage() {
  const params = useParams();
  const searchParams = useClientSearchParams();
  const storeId = params?.storeId as string;
  const period = searchParams.get("period") || currentPeriod();

  const [data, setData] = useState<StoreLedgerWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function loadData() {
        if (!storeId || !period) return;
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const workspace = await apiClient.storeLedgers.workspace(storeId, `?period=${period}`);
        if (!ignore) {
          setData(workspace);
        }
      } catch (error) {
        if (!ignore) {
          setErrorMessage(error instanceof Error ? error.message : "加载失败");
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }
    void loadData();
    return () => {
      ignore = true;
    };
  }, [storeId, period]);

  const storeName = data?.store.name ?? "门店";

  const bankColumns: ColumnsType<BankTransaction> = getBankTransactionViewColumns();

  const revenueColumns: ColumnsType<RevenueRecord> = [
    {
      title: "营业日期",
      dataIndex: "revenue_date",
      width: 100,
    },
    {
      title: "渠道",
      dataIndex: "channel",
      width: 120,
      ellipsis: true,
    },
    {
      title: "经营收入",
      dataIndex: "gross_amount",
      width: 120,
      align: "right",
      render: (value) => <MoneyDisplay value={value} colorize />,
    },
    {
      title: "实收金额",
      dataIndex: "net_amount",
      width: 120,
      align: "right",
      render: (value) => <MoneyDisplay value={value} colorize />,
    },
    {
      title: "备注",
      dataIndex: "remark",
      ellipsis: true,
      render: (value) => value || "-",
    },
  ];

  const approvalColumns: ColumnsType<ApprovalInstance> = [
    {
      title: "审批单号",
      dataIndex: "approval_no",
      width: 150,
      render: (no) => no || "-",
    },
    {
      title: "标题",
      dataIndex: "title",
      width: 200,
      ellipsis: true,
    },
    {
      title: "提交时间",
      dataIndex: "submit_at",
      width: 140,
      render: (time) => (time ? time.slice(0, 16).replace("T", " ") : "-"),
    },
    {
      title: "状态",
      dataIndex: "approval_status",
      width: 100,
      render: (status) => <StatusBadge status={status} />,
    },
  ];

  const stats = useMemo(() => {
    if (!data) return null;

    const totalIncome = Number(data.metrics.income_amount || 0);
    const totalExpense = Number(data.metrics.expense_amount || 0);
    const unmatchedBank = data.metrics.unmatched_bank_transaction_count;
    const pendingApprovals = data.metrics.pending_approval_count;

    return {
      totalIncome,
      totalExpense,
      unmatchedBank,
      pendingApprovals,
      balance: totalIncome - totalExpense,
    };
  }, [data]);

  return (
    <AppShell
      title={storeName}
      kicker={`账期: ${period}`}
    >
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        {errorMessage && <Alert message="加载失败" description={errorMessage} type="error" showIcon closable />}

        {/* 导航菜单 */}
        {data ? (
          <StoreLedgerWorkspaceNav
            storeId={storeId}
            storeName={data.store.name}
            period={data.period}
            periodOptions={data.ledgers.map((ledger) => ({ label: ledger.period, value: ledger.period }))}
            ledgerStatusLabel={data.selected_ledger?.status === "closed" ? "已封账" : data.selected_ledger ? "进行中" : undefined}
            activeKey="overview"
          />
        ) : null}

        {/* 本期经营摘要 */}
        {stats && (
          <div className="store-ledger-overview-metrics">
            <Card size="small" className="store-ledger-overview-metric store-ledger-overview-metric--income">
              <div className="store-ledger-overview-metric__label">
                <RiseOutlined />
                <span>本期收入</span>
              </div>
              <Typography.Text className="store-ledger-overview-metric__value">
                {formatMoney(stats.totalIncome)}
              </Typography.Text>
              <Typography.Text type="secondary">营业收入合计</Typography.Text>
            </Card>
            <Card size="small" className="store-ledger-overview-metric store-ledger-overview-metric--expense">
              <div className="store-ledger-overview-metric__label">
                <FallOutlined />
                <span>本期支出</span>
              </div>
              <Typography.Text className="store-ledger-overview-metric__value">
                {formatMoney(stats.totalExpense)}
              </Typography.Text>
              <Typography.Text type="secondary">审批支出合计</Typography.Text>
            </Card>
            <Card size="small" className={`store-ledger-overview-metric ${stats.balance >= 0 ? "store-ledger-overview-metric--positive" : "store-ledger-overview-metric--negative"}`}>
              <div className="store-ledger-overview-metric__label">
                <DollarOutlined />
                <span>本期结余</span>
              </div>
              <Typography.Text className="store-ledger-overview-metric__value">
                {formatMoney(stats.balance)}
              </Typography.Text>
              <Typography.Text type="secondary">收入减支出</Typography.Text>
            </Card>
            <Card size="small" className={`store-ledger-overview-metric ${stats.unmatchedBank > 0 ? "store-ledger-overview-metric--warning" : ""}`}>
              <div className="store-ledger-overview-metric__label">
                <WarningOutlined />
                <span>待处理流水</span>
              </div>
              <Typography.Text className="store-ledger-overview-metric__value">
                {stats.unmatchedBank}<span className="store-ledger-overview-metric__unit">笔</span>
              </Typography.Text>
              <Typography.Text type="secondary">尚未完成对账</Typography.Text>
            </Card>
            <Card size="small" className={`store-ledger-overview-metric ${stats.pendingApprovals > 0 ? "store-ledger-overview-metric--info" : ""}`}>
              <div className="store-ledger-overview-metric__label">
                <ClockCircleOutlined />
                <span>待处理审批</span>
              </div>
              <Typography.Text className="store-ledger-overview-metric__value">
                {stats.pendingApprovals}<span className="store-ledger-overview-metric__unit">单</span>
              </Typography.Text>
              <Typography.Text type="secondary">费用明细尚未完成流水匹配</Typography.Text>
            </Card>
          </div>
        )}

        {/* 本期明细 */}
        {data ? (
          <Card size="small" title="本期明细" className="store-ledger-overview-data-card">
            <Tabs
              defaultActiveKey="bank"
              items={[
                {
                  key: "bank",
                  label: (
                    <Space size={4}>
                      <BankOutlined />
                      <span>银行流水</span>
                      <Badge count={data.metrics.bank_transaction_count} style={{ backgroundColor: "#14b8a6" }} />
                    </Space>
                  ),
                  children: (
                    <Table
                      rowKey="id"
                      columns={bankColumns}
                      dataSource={data.bank_transactions}
                      pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
                      size="small"
                      scroll={{ x: 800 }}
                    />
                  ),
                },
                {
                  key: "revenue",
                  label: (
                    <Space size={4}>
                      <WalletOutlined />
                      <span>营业收入</span>
                      <Badge count={data.metrics.revenue_record_count} style={{ backgroundColor: "#10b981" }} />
                    </Space>
                  ),
                  children: (
                    <Table
                      rowKey="id"
                      columns={revenueColumns}
                      dataSource={data.revenue_records}
                      pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
                      size="small"
                      scroll={{ x: 800 }}
                    />
                  ),
                },
                {
                  key: "approval",
                  label: (
                    <Space size={4}>
                      <FileTextOutlined />
                      <span>审批单</span>
                      <Badge count={data.metrics.approval_count} style={{ backgroundColor: "#3b82f6" }} />
                    </Space>
                  ),
                  children: (
                    <Table
                      rowKey="id"
                      columns={approvalColumns}
                      dataSource={data.approval_instances}
                      pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
                      size="small"
                      scroll={{ x: 800 }}
                    />
                  ),
                },
              ]}
            />
          </Card>
        ) : isLoading ? (
          <Card loading />
        ) : (
          <Empty description="暂无数据" />
        )}
      </Space>
    </AppShell>
  );
}
