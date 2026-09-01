"use client";

import { Alert, Button, Card, Descriptions, Drawer, Empty, List, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ApprovalInstance, Attachment, ExpenseItem, Ledger, ReconciliationRecord, Store } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../../lib/api";
import { useClientSearchParams } from "../../../lib/searchParams";

function periodOfDate(value?: string | null) {
  return value ? value.slice(0, 7) : "";
}

function formatDateTime(value?: string | null) {
  return value ? value.replace("T", " ").slice(0, 16) : "-";
}

function approvalTitle(instance: ApprovalInstance) {
  return instance.approval_no || instance.dingtalk_instance_id;
}

function parseList(value?: string | null): string[] {
  if (!value) return [];
  try {
    const decoded = JSON.parse(value);
    return Array.isArray(decoded) ? decoded.map(String) : [];
  } catch {
    return [];
  }
}

function syncStatusColor(status?: string | null) {
  if (!status || status === "none") return "green";
  if (status.includes("removed") || status.includes("changed")) return "orange";
  return "default";
}

function paymentStatusLabel(status?: string | null) {
  if (status === "paid") return "已付款";
  if (status === "partial_paid") return "部分付款";
  if (status === "no_bank_flow") return "无需银行流水";
  return "未付款";
}

function processingStatusTag(status?: string | null) {
  if (status === "matched") return <Tag color="green">已匹配</Tag>;
  if (status === "partial_matched") return <Tag color="blue">部分匹配</Tag>;
  if (status === "pending_match") return <Tag color="orange">待匹配</Tag>;
  if (status === "pending_classification") return <Tag color="gold">待分类</Tag>;
  if (status === "sync_conflict") return <Tag color="red">同步待处理</Tag>;
  return <Tag color="orange">未解析</Tag>;
}

export default function StoreLedgerApprovalsPage() {
  const params = useParams<{ storeId: string }>();
  const router = useRouter();
  const searchParams = useClientSearchParams();
  const storeId = params.storeId;
  const [store, setStore] = useState<Store | null>(null);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInstance[]>([]);
  const [matches, setMatches] = useState<ReconciliationRecord[]>([]);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalInstance | null>(null);
  const [detailExpenses, setDetailExpenses] = useState<ExpenseItem[]>([]);
  const [detailAttachments, setDetailAttachments] = useState<Attachment[]>([]);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState(searchParams.get("period") || "");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function loadData() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [storePage, ledgerPage, approvalPage, confirmedMatchPage, candidateMatchPage] = await Promise.all([
          apiClient.stores.list("?page_size=500"),
          apiClient.ledgers.list(`?store_id=${encodeURIComponent(storeId)}&page_size=200`),
          apiClient.dingtalk.listApprovalInstances(`?store_id=${encodeURIComponent(storeId)}&page_size=500`),
          apiClient.matches.reconciliationRecords(`?store_id=${encodeURIComponent(storeId)}&status=confirmed&page_size=200`),
          apiClient.matches.reconciliationRecords(`?store_id=${encodeURIComponent(storeId)}&status=candidate&page_size=200`),
        ]);
        if (!ignore) {
          const nextLedgers = ledgerPage.items.sort((left, right) => right.period.localeCompare(left.period));
          setStore(storePage.items.find((item) => item.id === storeId) ?? null);
          setLedgers(nextLedgers);
          setApprovals(approvalPage.items);
          setMatches([...confirmedMatchPage.items, ...candidateMatchPage.items]);
          if (!selectedPeriod) setSelectedPeriod(nextLedgers[0]?.period ?? "");
        }
      } catch (error) {
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "无法加载审批单");
      } finally {
        if (!ignore) setIsLoading(false);
      }
    }
    void loadData();
    return () => {
      ignore = true;
    };
  }, [selectedPeriod, storeId]);

  const periodOptions = useMemo(
    () => ledgers.map((ledger) => ({ label: ledger.period, value: ledger.period })),
    [ledgers],
  );
  const filteredApprovals = selectedPeriod
    ? approvals.filter((approval) => periodOfDate(approval.submit_at) === selectedPeriod)
    : approvals;
  const matchedAmountByExpenseId = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of matches) {
      const id = record.expense_item.id;
      map.set(id, (map.get(id) ?? 0) + Number(record.match.amount || 0));
    }
    return map;
  }, [matches]);

  async function openApprovalDetail(approval: ApprovalInstance) {
    setSelectedApproval(approval);
    setIsDetailLoading(true);
    try {
      const [expensePage, attachmentPage] = await Promise.all([
        apiClient.expenseItems.list(`?approval_instance_id=${encodeURIComponent(approval.id)}&page_size=200`),
        apiClient.attachments.list(`?resource_type=approval_instance&resource_id=${encodeURIComponent(approval.id)}&page_size=100`),
      ]);
      setDetailExpenses(expensePage.items);
      setDetailAttachments(attachmentPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载审批单详情");
    } finally {
      setIsDetailLoading(false);
    }
  }

  function goReconciliation(approval?: ApprovalInstance | null) {
    const params = new URLSearchParams();
    params.set("store_id", storeId);
    if (selectedPeriod) params.set("ledger_period", selectedPeriod);
    const approvalNo = approval ? approval.approval_no || approval.dingtalk_instance_id : "";
    if (approvalNo) params.set("approval_no", approvalNo);
    router.push(`/finance/reconciliation?${params.toString()}`);
  }

  const columns: ColumnsType<ApprovalInstance> = [
    { title: "审批编号", dataIndex: "approval_no", render: (value, record) => <Button type="link" onClick={() => openApprovalDetail(record)}>{value || record.dingtalk_instance_id}</Button> },
    { title: "申请人", dataIndex: "applicant_name", render: (value) => value || "-" },
    { title: "部门", dataIndex: "department_name", render: (value) => value || "-" },
    {
      title: "状态",
      dataIndex: "approval_status",
      render: (value: string) => <Tag color={value?.toLowerCase?.().includes("reject") ? "red" : "green"}>{value || "-"}</Tag>,
    },
    {
      title: "明细",
      render: (_, record) => record.expense_item_count
        ? `${record.classified_expense_item_count}/${record.expense_item_count} 已分类`
        : "未解析",
    },
    {
      title: "金额",
      render: (_, record) => {
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text>{formatMoney(record.total_expense_amount)}</Typography.Text>
            <Typography.Text type="secondary">已匹配 {formatMoney(record.confirmed_match_amount)}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: "处理状态",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          {processingStatusTag(record.processing_status)}
          {record.candidate_match_count ? <Typography.Text type="secondary">候选 {record.candidate_match_count}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "提交时间", dataIndex: "submit_at", render: formatDateTime },
    {
      title: "操作",
      width: 150,
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openApprovalDetail(record)}>详情</Button>
          <Button size="small" type="primary" disabled={record.processing_status === "unparsed"} onClick={() => goReconciliation(record)}>去对账</Button>
        </Space>
      ),
    },
  ];
  const detailExpenseColumns: ColumnsType<ExpenseItem> = [
    { title: "行", dataIndex: "approval_line_no", width: 56, render: (value) => value || "-" },
    { title: "来源", dataIndex: "approval_line_source_type", width: 96, render: (value) => <Tag>{value || "整单"}</Tag> },
    { title: "摘要", dataIndex: "description" },
    { title: "金额", dataIndex: "amount", width: 110, render: (value: string) => formatMoney(value) },
    {
      title: "分类",
      width: 160,
      render: (_, record) => record.category_l1 || record.category_l2 ? [record.category_l1, record.category_l2].filter(Boolean).join(" / ") : <Tag color="orange">待分类</Tag>,
    },
    {
      title: "匹配",
      width: 150,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Tag color={record.payment_status === "paid" ? "green" : record.payment_status === "partial_paid" ? "blue" : "orange"}>
            {paymentStatusLabel(record.payment_status)}
          </Tag>
          <Typography.Text type="secondary">{formatMoney(matchedAmountByExpenseId.get(record.id) ?? 0)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "同步",
      width: 120,
      render: (_, record) => (
        <Tag color={syncStatusColor(record.sync_conflict_status)}>
          {record.sync_conflict_status && record.sync_conflict_status !== "none" ? record.sync_conflict_status : "正常"}
        </Tag>
      ),
    },
    {
      title: "操作",
      width: 96,
      render: (_, record) => (
        <Button
          size="small"
          type="link"
          onClick={() => goReconciliation(selectedApproval)}
          disabled={!record.approval_instance_id}
        >
          去对账
        </Button>
      ),
    },
  ];
  const detailTotal = detailExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const detailMatched = detailExpenses.reduce((sum, item) => sum + (matchedAmountByExpenseId.get(item.id) ?? 0), 0);

  return (
    <AppShell
      title={`${store?.name ?? "门店"}审批单管理`}
      kicker={selectedPeriod ? `账期：${selectedPeriod}` : "按门店查看审批单"}
      action={
        <Space>
          <Button onClick={() => goReconciliation()}>进入对账</Button>
          <Button type="primary" onClick={() => router.push("/dingtalk")}>同步审批单</Button>
        </Space>
      }
    >
      <StoreLedgerWorkspaceNav
        storeId={storeId}
        storeName={store?.name}
        period={selectedPeriod}
        periodOptions={periodOptions}
        statusLabel={store?.status === "active" ? "启用门店" : store ? "停用门店" : undefined}
        activeKey="approvals"
        onPeriodChange={setSelectedPeriod}
      />
      {errorMessage ? <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon /> : null}
      <Card title="审批单列表" loading={isLoading}>
        {filteredApprovals.length ? (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={filteredApprovals}
            onRow={(record) => ({ onDoubleClick: () => openApprovalDetail(record) })}
          />
        ) : (
          <Empty description="当前门店账期暂无审批单" />
        )}
      </Card>
      <Drawer
        title={selectedApproval ? `审批单详情：${approvalTitle(selectedApproval)}` : "审批单详情"}
        open={Boolean(selectedApproval)}
        onClose={() => setSelectedApproval(null)}
        width={980}
      >
        {selectedApproval ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={3} size="small" bordered>
              <Descriptions.Item label="审批编号">{approvalTitle(selectedApproval)}</Descriptions.Item>
              <Descriptions.Item label="申请人">{selectedApproval.applicant_name || "-"}</Descriptions.Item>
              <Descriptions.Item label="部门">{selectedApproval.department_name || "-"}</Descriptions.Item>
              <Descriptions.Item label="审批状态">{selectedApproval.approval_status}</Descriptions.Item>
              <Descriptions.Item label="提交时间">{formatDateTime(selectedApproval.submit_at)}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{formatDateTime(selectedApproval.approved_at)}</Descriptions.Item>
            </Descriptions>
            <Space size="large" wrap>
              <Statistic title="费用明细" value={detailExpenses.length} suffix="条" />
              <Statistic title="审批金额" value={formatMoney(detailTotal)} />
              <Statistic title="已匹配银行流水" value={formatMoney(detailMatched)} />
              <Statistic title="未匹配金额" value={formatMoney(Math.max(detailTotal - detailMatched, 0))} />
            </Space>
            <Button type="primary" onClick={() => goReconciliation(selectedApproval)} disabled={!detailExpenses.length}>
              去对账处理
            </Button>
            <Card title="费用明细" loading={isDetailLoading}>
              <Table rowKey="id" columns={detailExpenseColumns} dataSource={detailExpenses} pagination={false} size="small" />
            </Card>
            <Card title="收款账户">
              {detailExpenses[0] ? (
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="收款人">{detailExpenses[0].payee_name || detailExpenses[0].payee_account || "-"}</Descriptions.Item>
                  <Descriptions.Item label="银行">{detailExpenses[0].payee_bank_name || "-"}</Descriptions.Item>
                  <Descriptions.Item label="支行/开户地">{detailExpenses[0].payee_bank_branch || "-"}</Descriptions.Item>
                  <Descriptions.Item label="账号">{detailExpenses[0].payee_account_no || detailExpenses[0].payee_account || "-"}</Descriptions.Item>
                  <Descriptions.Item label="账户类型">{detailExpenses[0].payee_account_type || "-"}</Descriptions.Item>
                  <Descriptions.Item label="校验状态">{detailExpenses[0].payee_account_verify_status || "-"}</Descriptions.Item>
                </Descriptions>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无收款账户信息" />
              )}
            </Card>
            <Card title="审批单附件">
              {detailAttachments.length ? (
                <List
                  dataSource={detailAttachments}
                  renderItem={(item) => (
                    <List.Item>
                      <Space>
                        <Typography.Text>{item.file_name}</Typography.Text>
                        <Tag>{item.download_status}</Tag>
                      </Space>
                    </List.Item>
                  )}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无附件" />
              )}
            </Card>
            <Card title="人工编辑保护">
              {detailExpenses.some((item) => parseList(item.user_edited_fields_json).length) ? (
                <List
                  dataSource={detailExpenses.filter((item) => parseList(item.user_edited_fields_json).length)}
                  renderItem={(item) => (
                    <List.Item>
                      <Typography.Text>{item.description}：{parseList(item.user_edited_fields_json).join("、")}</Typography.Text>
                    </List.Item>
                  )}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无人工覆盖字段" />
              )}
            </Card>
          </Space>
        ) : null}
      </Drawer>
      <Typography.Paragraph type="secondary" className="store-ledger-page-note">
        审批单按提交时间归入账期；审批数据来自钉钉同步，费用入账和对账在对账管理中完成。
      </Typography.Paragraph>
    </AppShell>
  );
}
