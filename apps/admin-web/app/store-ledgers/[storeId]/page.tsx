"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Typography,
  Tabs,
  Badge,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  BankOutlined,
  FileTextOutlined,
  ReconciliationOutlined,
  WalletOutlined,
  DollarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  SwapOutlined,
  RiseOutlined,
  FallOutlined,
} from "@ant-design/icons";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ApprovalInstance, BankTransaction, RevenueRecord, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { AppShell } from "../../components/AppShell";
import { MoneyDisplay } from "../../components/MoneyDisplay";
import { StatusBadge } from "../../components/StatusBadge";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { getStoreLedgers } from "../../lib/referenceData";
import { useClientSearchParams } from "../../lib/searchParams";

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

export default function StoreLedgerWorkspacePage() {
  const params = useParams();
  const searchParams = useClientSearchParams();
  const router = useRouter();
  const storeId = params?.storeId as string;
  const period = searchParams.get("period") || currentPeriod();

  const [data, setData] = useState<StoreLedgerWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPeriodModalOpen, setIsPeriodModalOpen] = useState(false);
  const [availablePeriods, setAvailablePeriods] = useState<string[]>([]);

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

  useEffect(() => {
    if (!storeId) return;
    void (async () => {
      try {
        const ledgers = await getStoreLedgers(storeId);
        const periods = Array.from(new Set(ledgers.map((ledger) => ledger.period))).sort().reverse();
        setAvailablePeriods(periods);
      } catch {
        setAvailablePeriods([]);
      }
    })();
  }, [storeId]);

  const storeName = data?.store.name ?? "门店";

  const bankColumns: ColumnsType<BankTransaction> = [
    {
      title: "交易日期",
      dataIndex: "occurred_at",
      width: 100,
      render: (date) => date?.slice(0, 10) || "-",
    },
    {
      title: "对方户名",
      dataIndex: "counterparty_name",
      width: 180,
      ellipsis: true,
      render: (value) => value || "-",
    },
    {
      title: "金额",
      dataIndex: "amount",
      width: 120,
      align: "right",
      render: (value) => <MoneyDisplay value={value} colorize />,
    },
    {
      title: "已匹配",
      dataIndex: "matched_amount",
      width: 120,
      align: "right",
      render: (value) => <MoneyDisplay value={value || 0} />,
    },
    {
      title: "摘要",
      dataIndex: "summary",
      ellipsis: true,
      render: (value) => value || "-",
    },
  ];

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
    const totalExpense = data.approval_instances.reduce((sum, approval) => sum + Number(approval.total_expense_amount || 0), 0);
    const unmatchedBank = data.bank_transactions.filter(
      (b) => Number(b.matched_amount || 0) < Number(b.amount) * 0.99
    ).length;
    const pendingApprovals = data.approval_instances.filter(
      (a) => a.approval_status === "RUNNING" || a.approval_status === "NEW"
    ).length;

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
      action={
        <Space>
          <Button onClick={() => setIsPeriodModalOpen(true)}>切换账期</Button>
          <Button type="primary" onClick={() => router.push(`/matching?store_id=${storeId}`)}>
            <SwapOutlined /> 进入匹配
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        {errorMessage && <Alert message="加载失败" description={errorMessage} type="error" showIcon closable />}

        {/* 紧凑的统计卡片 */}
        {stats && (
          <Row gutter={12}>
            <Col span={6}>
              <Card size="small" style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}>
                <Statistic
                  title={<span style={{ color: "rgba(255,255,255,0.85)", fontSize: 12 }}>本期收入</span>}
                  value={stats.totalIncome}
                  precision={2}
                  valueStyle={{ color: "white", fontSize: 20 }}
                  prefix={<RiseOutlined />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small" style={{ background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)" }}>
                <Statistic
                  title={<span style={{ color: "rgba(255,255,255,0.85)", fontSize: 12 }}>本期支出</span>}
                  value={stats.totalExpense}
                  precision={2}
                  valueStyle={{ color: "white", fontSize: 20 }}
                  prefix={<FallOutlined />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title="未匹配流水"
                  value={stats.unmatchedBank}
                  suffix="笔"
                  valueStyle={{ color: stats.unmatchedBank > 0 ? "#f59e0b" : "#525252", fontSize: 20 }}
                  prefix={<WarningOutlined style={{ color: stats.unmatchedBank > 0 ? "#f59e0b" : "#525252" }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title="待审批单"
                  value={stats.pendingApprovals}
                  suffix="个"
                  valueStyle={{ color: stats.pendingApprovals > 0 ? "#3b82f6" : "#525252", fontSize: 20 }}
                  prefix={<ClockCircleOutlined style={{ color: stats.pendingApprovals > 0 ? "#3b82f6" : "#525252" }} />}
                />
              </Card>
            </Col>
          </Row>
        )}

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

        {/* 紧凑的标签页内容 */}
        {data ? (
          <Card
            size="small"
            styles={{
              body: { padding: "12px 16px" },
            }}
          >
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

      {/* 切换账期模态框 */}
      <Modal
        title="切换账期"
        open={isPeriodModalOpen}
        onCancel={() => setIsPeriodModalOpen(false)}
        footer={null}
        width={400}
      >
        {availablePeriods.length ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            {availablePeriods.map((p) => (
              <Button
                key={p}
                type={p === period ? "primary" : "default"}
                block
                onClick={() => {
                  router.push(`/store-ledgers/${storeId}?period=${p}`);
                  setIsPeriodModalOpen(false);
                }}
              >
                {p} {p === period && "(当前)"}
              </Button>
            ))}
          </Space>
        ) : (
          <Empty description="当前账期暂无账套" />
        )}
      </Modal>
    </AppShell>
  );
}
