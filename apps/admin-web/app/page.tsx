"use client";

import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  List,
  Progress,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  BankOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  FileSearchOutlined,
  RightOutlined,
  ShopOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  FinancialAnalyticsReport,
  FinancialAnalyticsStoreItem,
  ReconciliationRecord,
  Store,
  SyncJob,
} from "@fin-hub/shared-types";
import { apiClient } from "./lib/api";
import { getStores } from "./lib/referenceData";
import { AppShell } from "./components/AppShell";

interface WorkbenchData {
  analytics: FinancialAnalyticsReport | null;
  stores: Store[];
  syncJobs: SyncJob[];
  recentMatches: ReconciliationRecord[];
}

const emptyData: WorkbenchData = {
  analytics: null,
  stores: [],
  syncJobs: [],
  recentMatches: [],
};

const syncStatusColor: Record<SyncJob["status"], string> = {
  pending: "default",
  running: "processing",
  succeeded: "success",
  failed: "error",
};

const syncStatusText: Record<SyncJob["status"], string> = {
  pending: "等待中",
  running: "同步中",
  succeeded: "成功",
  failed: "失败",
};

function money(value?: string | number | null) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortDate(value?: string | null) {
  if (!value) return "-";
  return value.replace("T", " ").slice(0, 16);
}

function topActionStores(stores: FinancialAnalyticsStoreItem[]) {
  return [...stores]
    .sort((left, right) => {
      const leftScore = left.unmatched_bank_count * 3 + left.pending_expense_count;
      const rightScore = right.unmatched_bank_count * 3 + right.pending_expense_count;
      return rightScore - leftScore;
    })
    .slice(0, 6);
}

interface WorkbenchMetricProps {
  title: string;
  value: string | number;
  unit: string;
  description: string;
  icon: React.ReactNode;
  tone?: "normal" | "warning" | "danger" | "success";
  actionLabel: string;
  onClick: () => void;
}

function WorkbenchMetricCard({
  title,
  value,
  unit,
  description,
  icon,
  tone = "normal",
  actionLabel,
  onClick,
}: WorkbenchMetricProps) {
  return (
    <Card className={`workbench-metric-card ${tone}`}>
      <Flex vertical gap={14} className="full-width">
        <Flex align="flex-start" justify="space-between" gap={12}>
          <div>
            <Typography.Text className="workbench-metric-title">{title}</Typography.Text>
            <div className="workbench-metric-value-row">
              <span className="workbench-metric-value">{value}</span>
              <span className="workbench-metric-unit">{unit}</span>
            </div>
          </div>
          <span className="workbench-metric-icon">{icon}</span>
        </Flex>
        <Flex align="center" justify="space-between" gap={10}>
          <Typography.Text className="workbench-metric-desc">{description}</Typography.Text>
          <Button type="link" size="small" className="workbench-metric-action" onClick={onClick}>
            {actionLabel}
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

function StoreActionRow({
  store,
  onOpen,
}: {
  store: FinancialAnalyticsStoreItem;
  onOpen: () => void;
}) {
  const workload = store.unmatched_bank_count + store.pending_expense_count;
  return (
    <button className="workbench-store-row" type="button" onClick={onOpen}>
      <span className="workbench-list-icon">
        <ShopOutlined />
      </span>
      <span className="workbench-store-main">
        <span className="workbench-store-name">{store.store_name}</span>
        <span className="workbench-store-tags">
          <Tag color={store.unmatched_bank_count > 0 ? "orange" : "default"}>待对账 {store.unmatched_bank_count}</Tag>
          <Tag color={store.pending_expense_count > 0 ? "blue" : "default"}>未付款 {store.pending_expense_count}</Tag>
        </span>
      </span>
      <span className="workbench-store-side">
        <span className="workbench-store-amount">{money(store.expense_amount)} 元</span>
        <span className="workbench-store-label">审批支出</span>
      </span>
      <RightOutlined className="workbench-store-arrow" />
      <span
        className={`workbench-store-bar ${workload > 5 ? "danger" : workload > 0 ? "warning" : "normal"}`}
        style={{ width: `${Math.min(workload * 10, 100)}%` }}
      />
    </button>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [data, setData] = useState<WorkbenchData>(emptyData);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    async function loadWorkbench() {
      setIsLoading(true);
      setErrorMessage(null);
      const errors: string[] = [];
      const tasks = [
        apiClient.reports.analytics()
          .then((analytics) => {
            if (!ignore) setData((current) => ({ ...current, analytics }));
          })
          .catch(() => errors.push("经营统计")),
        getStores()
          .then((stores) => {
            if (!ignore) setData((current) => ({ ...current, stores }));
          })
          .catch(() => errors.push("门店")),
        apiClient.dingtalk.listSyncJobs("?page_size=5")
          .then((syncJobs) => {
            if (!ignore) setData((current) => ({ ...current, syncJobs: syncJobs.items }));
          })
          .catch(() => errors.push("同步任务")),
        apiClient.matches.reconciliationRecords("?status=confirmed&page_size=5")
          .then((recentMatches) => {
            if (!ignore) setData((current) => ({ ...current, recentMatches: recentMatches.items }));
          })
          .catch(() => errors.push("最近对账")),
      ];
      await Promise.allSettled(tasks);
      if (!ignore) {
        setIsLoading(false);
        setErrorMessage(errors.length ? `${errors.join("、")}加载失败` : null);
      }
    }

    loadWorkbench();
    return () => {
      ignore = true;
    };
  }, []);

  const metrics = data.analytics?.metrics;
  const actionStores = useMemo(() => topActionStores(data.analytics?.stores ?? []), [data.analytics]);
  const latestSyncJob = data.syncJobs[0];
  const syncFailedCount = data.syncJobs.filter((job) => job.status === "failed").length;
  const reconciliationProgress = metrics
    ? Math.round(
        (Number(metrics.matched_expense_amount) /
          Math.max(Number(metrics.matched_expense_amount) + Number(metrics.unmatched_bank_amount), 1)) *
          100,
      )
    : 0;

  return (
    <AppShell
      title="财务工作台"
      kicker="聚焦今天需要处理的对账、同步和门店异常"
      action={<Button onClick={() => router.push("/reports")}>查看统计报表</Button>}
    >
      {errorMessage ? (
        <Alert
          className="dashboard-alert"
          message="工作台数据暂不可用"
          description={errorMessage}
          type="warning"
          showIcon
          closable
          onClose={() => setErrorMessage(null)}
        />
      ) : null}

      <Spin spinning={isLoading}>
        <Space direction="vertical" size={16} className="full-width">
          <Flex gap={16} wrap="wrap" className="metrics">
            <WorkbenchMetricCard
              title="待对账流水"
              value={metrics?.unmatched_bank_count ?? 0}
              unit="笔"
              description="银行支出尚未匹配审批单"
              icon={<BankOutlined />}
              tone={(metrics?.unmatched_bank_count ?? 0) > 0 ? "warning" : "normal"}
              actionLabel="进入对账"
              onClick={() => router.push("/finance/reconciliation")}
            />
            <WorkbenchMetricCard
              title="未付款审批"
              value={metrics?.pending_expense_count ?? 0}
              unit="单"
              description="审批通过但付款状态待确认"
              icon={<FileSearchOutlined />}
              tone={(metrics?.pending_expense_count ?? 0) > 0 ? "warning" : "success"}
              actionLabel="查看审批"
              onClick={() => router.push("/dingtalk")}
            />
            <WorkbenchMetricCard
              title="未对账金额"
              value={money(metrics?.unmatched_bank_amount)}
              unit="元"
              description="需要人工确认归属的流水金额"
              icon={<WarningOutlined />}
              tone={Number(metrics?.unmatched_bank_amount ?? 0) > 0 ? "danger" : "success"}
              actionLabel="处理差异"
              onClick={() => router.push("/finance/reconciliation")}
            />
            <WorkbenchMetricCard
              title="授权门店"
              value={metrics?.store_count ?? data.stores.length}
              unit="家"
              description="当前账号可查看和维护的门店"
              icon={<ShopOutlined />}
              actionLabel="门店档案"
              onClick={() => router.push("/stores")}
            />
          </Flex>

          <Row gutter={[16, 16]}>
            <Col xs={24} xl={15}>
              <Card
                title="门店待处理"
                extra={<Button type="link" onClick={() => router.push("/finance/reconciliation")}>去对账</Button>}
              >
                {actionStores.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有待处理门店" />
                ) : (
                  <div className="workbench-store-list">
                    {actionStores.map((store) => (
                      <StoreActionRow
                        key={store.store_id}
                        store={store}
                        onOpen={() => router.push(`/finance/reconciliation?store_id=${store.store_id}`)}
                      />
                    ))}
                  </div>
                )}
              </Card>
            </Col>

            <Col xs={24} xl={9}>
              <Space direction="vertical" size={16} className="full-width">
                <Card title="数据同步状态" extra={<Button type="link" onClick={() => router.push("/dingtalk")}>查看同步</Button>}>
                  {latestSyncJob ? (
                    <Space direction="vertical" size={12} className="full-width">
                      <Flex justify="space-between" align="center">
                        <Space>
                          <CloudSyncOutlined className="workbench-status-icon" />
                          <Typography.Text strong>{latestSyncJob.job_type}</Typography.Text>
                        </Space>
                        <Tag color={syncStatusColor[latestSyncJob.status]}>{syncStatusText[latestSyncJob.status]}</Tag>
                      </Flex>
                      <Typography.Text type="secondary">
                        最近完成：{shortDate(latestSyncJob.finished_at ?? latestSyncJob.updated_at)}
                      </Typography.Text>
                      <Flex gap={8} wrap="wrap">
                        <Tag>处理 {latestSyncJob.processed_count}</Tag>
                        <Tag color="green">成功 {latestSyncJob.success_count}</Tag>
                        <Tag color={latestSyncJob.failed_count > 0 ? "red" : "default"}>
                          失败 {latestSyncJob.failed_count}
                        </Tag>
                      </Flex>
                      {syncFailedCount > 0 ? (
                        <Alert type="warning" showIcon message={`最近 ${syncFailedCount} 个同步任务失败，需要检查钉钉配置或权限。`} />
                      ) : null}
                    </Space>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无同步任务" />
                  )}
                </Card>

                <Card title="对账进度">
                  <Space direction="vertical" size={12} className="full-width">
                    <Progress percent={reconciliationProgress} strokeColor="#14b8a6" />
                    <Flex justify="space-between">
                      <Typography.Text type="secondary">已对账 {money(metrics?.matched_expense_amount)} 元</Typography.Text>
                      <Typography.Text type="secondary">未对账 {money(metrics?.unmatched_bank_amount)} 元</Typography.Text>
                    </Flex>
                  </Space>
                </Card>
              </Space>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} xl={15}>
              <Card title="最近对账记录" extra={<Button type="link" onClick={() => router.push("/finance/reconciliation")}>全部记录</Button>}>
                {data.recentMatches.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已确认对账记录" />
                ) : (
                  <List
                    dataSource={data.recentMatches}
                    renderItem={(record) => (
                      <List.Item>
                        <List.Item.Meta
                          avatar={<CheckCircleOutlined className="workbench-list-icon success" />}
                          title={
                            <Space wrap>
                              <Typography.Text strong>
                                {record.approval_instance?.approval_no ?? record.expense_item.source_document_id ?? "审批单"}
                              </Typography.Text>
                              <Tag color="green">已确认</Tag>
                            </Space>
                          }
                          description={
                            <Space wrap>
                              <Typography.Text>{record.expense_item.description}</Typography.Text>
                              <Typography.Text type="secondary">流水 {shortDate(record.bank_transaction.occurred_at)}</Typography.Text>
                              <Typography.Text type="secondary">入账 {record.match.accounting_period ?? "-"}</Typography.Text>
                            </Space>
                          }
                        />
                        <Typography.Text strong>{money(record.match.amount)} 元</Typography.Text>
                      </List.Item>
                    )}
                  />
                )}
              </Card>
            </Col>

            <Col xs={24} xl={9}>
              <Card title="常用操作">
                <Space direction="vertical" size={10} className="full-width">
                  <Button block icon={<BankOutlined />} onClick={() => router.push("/finance/reconciliation")}>
                    导入流水并对账
                  </Button>
                  <Button block icon={<CloudSyncOutlined />} onClick={() => router.push("/dingtalk")}>
                    同步钉钉审批
                  </Button>
                  <Button block icon={<FileSearchOutlined />} onClick={() => router.push("/reports")}>
                    查看统计报表
                  </Button>
                  <Button block icon={<WarningOutlined />} onClick={() => router.push("/categories")}>
                    维护费用分类
                  </Button>
                </Space>
              </Card>
            </Col>
          </Row>
        </Space>
      </Spin>
    </AppShell>
  );
}
