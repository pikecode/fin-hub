"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  List,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  BankOutlined,
  FileTextOutlined,
  ReconciliationOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ApprovalInstance, BankTransaction, RevenueRecord, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { useClientSearchParams } from "../../lib/searchParams";

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

function moduleQuery(storeId: string, period: string) {
  return new URLSearchParams({ store_id: storeId, ledger_period: period }).toString();
}

export default function StoreLedgerWorkspacePage() {
  const params = useParams<{ storeId: string }>();
  const router = useRouter();
  const searchParams = useClientSearchParams();
  const storeId = params.storeId;
  const [data, setData] = useState<StoreLedgerWorkspace | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState(searchParams.get("period") || currentPeriod());
  const [isLoading, setIsLoading] = useState(true);
  const [isClosing, setIsClosing] = useState(false);
  const [isClosePreviewOpen, setIsClosePreviewOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadWorkspace(requestedPeriod = searchParams.get("period") || selectedPeriod) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const workspace = await apiClient.storeLedgers.workspace(
        storeId,
        `?period=${encodeURIComponent(requestedPeriod)}&preview_size=8`,
      );
      setData(workspace);
      if (workspace.period !== selectedPeriod) {
        setSelectedPeriod(workspace.period);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载门店套帐");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let ignore = false;
    async function loadData(requestedPeriod = searchParams.get("period") || selectedPeriod) {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const workspace = await apiClient.storeLedgers.workspace(
          storeId,
          `?period=${encodeURIComponent(requestedPeriod)}&preview_size=8`,
        );
        if (!ignore) {
          setData(workspace);
          if (workspace.period !== selectedPeriod) {
            setSelectedPeriod(workspace.period);
          }
        }
      } catch (error) {
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "无法加载门店套帐");
      } finally {
        if (!ignore) setIsLoading(false);
      }
    }
    void loadData();
    return () => {
      ignore = true;
    };
  }, [searchParams, selectedPeriod, storeId]);

  const metrics = data?.metrics;
  const selectedLedger = data?.selected_ledger;
  const closeCheck = data?.close_check;
  const periodOptions = useMemo(
    () => data?.ledgers.map((ledger) => ({ label: ledger.period, value: ledger.period })) ?? [],
    [data?.ledgers],
  );

  async function closeSelectedLedger() {
    if (!selectedLedger || !closeCheck?.can_close) {
      return;
    }
    setIsClosing(true);
    setErrorMessage(null);
    try {
      await apiClient.ledgers.close(selectedLedger.id, "admin");
      setIsClosePreviewOpen(false);
      await loadWorkspace(selectedPeriod);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法封账");
    } finally {
      setIsClosing(false);
    }
  }

  const revenueColumns: ColumnsType<RevenueRecord> = [
    { title: "日期", dataIndex: "revenue_date" },
    { title: "渠道", dataIndex: "channel" },
    { title: "金额", dataIndex: "gross_amount", render: (value: string) => formatMoney(value) },
    { title: "实收", dataIndex: "net_amount", render: (value: string) => formatMoney(value) },
    { title: "手续费", dataIndex: "fee_amount", render: (value: string) => formatMoney(value) },
  ];
  const bankColumns: ColumnsType<BankTransaction> = [
    { title: "日期", dataIndex: "occurred_at", render: (value: string) => value.replace("T", " ").slice(0, 16) },
    { title: "方向", dataIndex: "direction", render: (value: string) => (value === "income" ? "收入" : "支出") },
    { title: "对方户名", dataIndex: "counterparty_name", render: (value) => value || "-" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "已匹配", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
  ];
  const approvalColumns: ColumnsType<ApprovalInstance> = [
    { title: "审批编号", dataIndex: "approval_no", render: (value, record) => value || record.dingtalk_instance_id },
    { title: "申请人", dataIndex: "applicant_name", render: (value) => value || "-" },
    { title: "状态", dataIndex: "approval_status" },
    { title: "提交时间", dataIndex: "submit_at", render: (value: string | null) => value?.replace("T", " ").slice(0, 16) || "-" },
  ];

  return (
    <AppShell
      title={data?.store.name ?? "门店套帐"}
      kicker={`当前账期：${selectedPeriod}`}
    >
      {errorMessage ? <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon /> : null}
      <StoreLedgerWorkspaceNav
        storeId={storeId}
        storeName={data?.store.name}
        period={selectedPeriod}
        periodOptions={periodOptions}
        statusLabel={data?.store.status === "active" ? "启用门店" : data?.store ? "停用门店" : undefined}
        ledgerStatusLabel={selectedLedger?.status === "closed" ? "已封账" : selectedLedger ? "做账中" : undefined}
        activeKey="overview"
        onPeriodChange={setSelectedPeriod}
        extra={selectedLedger ? (
          <Button onClick={() => setIsClosePreviewOpen(true)}>
            {selectedLedger.status === "closed" ? "查看封账状态" : "封账预检"}
          </Button>
        ) : null}
      />
      {!isLoading && !data?.store ? <Empty description="未找到门店" /> : null}
      {selectedLedger && closeCheck && selectedLedger.status !== "closed" && !closeCheck.can_close ? (
        <Alert
          className="dashboard-alert"
          type="warning"
          showIcon
          message="当前账期暂不能封账"
          description={closeCheck.issues.join("；")}
          action={<Button size="small" onClick={() => setIsClosePreviewOpen(true)}>查看预检</Button>}
        />
      ) : null}
      <Row gutter={[16, 16]} className="store-ledger-workbench-grid">
        <Col xs={24} md={12} xl={6}>
          <Card className="store-ledger-action-card" onClick={() => router.push(`/bank?${moduleQuery(storeId, selectedPeriod)}`)}>
            <Statistic prefix={<BankOutlined />} title="银行流水" value={metrics?.bank_transaction_count ?? 0} suffix="笔" />
            <Typography.Text type="secondary">未完全匹配 {metrics?.unmatched_bank_transaction_count ?? 0} 笔</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card className="store-ledger-action-card" onClick={() => router.push(`/store-ledgers/${storeId}/approvals?period=${selectedPeriod}`)}>
            <Statistic prefix={<FileTextOutlined />} title="审批单" value={metrics?.approval_count ?? 0} suffix="张" />
            <Typography.Text type="secondary">待处理 {metrics?.pending_approval_count ?? 0} 张</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card className="store-ledger-action-card" onClick={() => router.push(`/finance/reconciliation?${moduleQuery(storeId, selectedPeriod)}`)}>
            <Statistic prefix={<ReconciliationOutlined />} title="对账管理" value={metrics?.unmatched_bank_transaction_count ?? 0} suffix="待处理" />
            <Typography.Text type="secondary">收入待确认 {metrics?.pending_revenue_match_count ?? 0} 条</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card className="store-ledger-action-card" onClick={() => router.push(`/revenue?${moduleQuery(storeId, selectedPeriod)}`)}>
            <Statistic prefix={<WalletOutlined />} title="营业收入" value={formatMoney(metrics?.income_amount ?? "0.00")} />
            <Typography.Text type="secondary">
              实收 {formatMoney(metrics?.net_income_amount ?? "0.00")}，手续费 {formatMoney(metrics?.fee_amount ?? "0.00")}
            </Typography.Text>
          </Card>
        </Col>
      </Row>
      <Modal
        title="封账预检"
        open={isClosePreviewOpen}
        onCancel={() => setIsClosePreviewOpen(false)}
        onOk={closeSelectedLedger}
        okButtonProps={{ disabled: selectedLedger?.status === "closed" || !closeCheck?.can_close }}
        okText={selectedLedger?.status === "closed" ? "已封账" : closeCheck?.can_close ? "确认封账" : "暂不能封账"}
        cancelText="关闭"
        confirmLoading={isClosing}
      >
        {selectedLedger && closeCheck ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="账期">{selectedPeriod}</Descriptions.Item>
              <Descriptions.Item label="状态">
                {selectedLedger.status === "closed" ? "已封账" : closeCheck.can_close ? "可封账" : "需处理"}
              </Descriptions.Item>
              <Descriptions.Item label="未付款支出">{closeCheck.unpaid_expense_count}</Descriptions.Item>
              <Descriptions.Item label="未匹配流水">{closeCheck.unmatched_bank_transaction_count}</Descriptions.Item>
              <Descriptions.Item label="营业收入记录">{closeCheck.revenue_record_count}</Descriptions.Item>
              <Descriptions.Item label="未对账收入">{closeCheck.unmatched_revenue_record_count}</Descriptions.Item>
              <Descriptions.Item label="未对账实收金额" span={2}>
                {formatMoney(closeCheck.unmatched_revenue_amount)}
              </Descriptions.Item>
              <Descriptions.Item label="候选匹配" span={2}>{closeCheck.candidate_match_count}</Descriptions.Item>
            </Descriptions>
            {closeCheck.issues.length ? (
              <Alert
                type="error"
                showIcon
                message="封账阻断项"
                description={<List size="small" dataSource={closeCheck.issues} renderItem={(item) => <List.Item>{item}</List.Item>} />}
              />
            ) : null}
            {closeCheck.warnings.length ? (
              <Alert
                type="warning"
                showIcon
                message="封账提示"
                description={<List size="small" dataSource={closeCheck.warnings} renderItem={(item) => <List.Item>{item}</List.Item>} />}
              />
            ) : null}
            {!closeCheck.issues.length && !closeCheck.warnings.length ? (
              <Alert type="success" showIcon message="预检通过，可以封账" />
            ) : null}
          </Space>
        ) : (
          <Empty description="当前账期暂无账套" />
        )}
      </Modal>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="最近银行流水" loading={isLoading}>
            <Table rowKey="id" columns={bankColumns} dataSource={data?.bank_transactions ?? []} pagination={false} size="small" />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="营业收入记录" loading={isLoading}>
            <Table rowKey="id" columns={revenueColumns} dataSource={data?.revenue_records ?? []} pagination={false} size="small" />
          </Card>
        </Col>
        <Col xs={24}>
          <Card title="审批单列表" loading={isLoading}>
            <Table rowKey="id" columns={approvalColumns} dataSource={data?.approval_instances ?? []} pagination={false} size="small" />
          </Card>
        </Col>
      </Row>
    </AppShell>
  );
}
