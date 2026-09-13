"use client";

import { Alert, Button, Card, Descriptions, Empty, List, Modal, Space, Table, Typography, Row, Col, message } from "antd";
import {
  FileTextOutlined,
  WalletOutlined,
  RiseOutlined,
  FallOutlined,
} from "@ant-design/icons";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { LedgerCloseCheck, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { MoneyDisplay } from "../../components/MoneyDisplay";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { useClientSearchParams } from "../../lib/searchParams";

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

function metricCard(title: string, value: string, subtitle: string, icon: React.ReactNode, tone?: "green" | "red" | "gold" | "blue") {
  return (
    <Card size="small" className={`store-ledger-report-metric ${tone ? `store-ledger-report-metric--${tone}` : ""}`}>
      <Space direction="vertical" size={8} className="full-width">
        <Space size={8} align="center">
          <span className="store-ledger-report-metric__icon">{icon}</span>
          <Typography.Text className="store-ledger-report-metric__title">{title}</Typography.Text>
        </Space>
        <Typography.Text className="store-ledger-report-metric__value">{value}</Typography.Text>
        <Typography.Text type="secondary" className="store-ledger-report-metric__subtitle">
          {subtitle}
        </Typography.Text>
      </Space>
    </Card>
  );
}

interface ExpenseCategoryTreeRow {
  key: string;
  name: string;
  amount: string;
  item_count: number;
  children?: ExpenseCategoryTreeRow[];
}

export default function StoreLedgerWorkspacePage() {
  const params = useParams();
  const searchParams = useClientSearchParams();
  const storeId = params?.storeId as string;
  const period = searchParams.get("period") || currentPeriod();

  const [data, setData] = useState<StoreLedgerWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [closePreview, setClosePreview] = useState<{ ledger: NonNullable<StoreLedgerWorkspace["selected_ledger"]>; check: LedgerCloseCheck } | null>(null);

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
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "加载失败");
      } finally {
        if (!ignore) setIsLoading(false);
      }
    }
    void loadData();
    return () => {
      ignore = true;
    };
  }, [storeId, period]);

  const storeName = data?.store.name ?? "门店";
  const stats = useMemo(() => {
    if (!data) return null;
    const profit = Number(data.metrics.revenue_income_amount || 0) - Number(data.metrics.expense_amount || 0);
    const grossIncome = Number(data.metrics.revenue_income_amount || 0);
    const grossProfit = Number(data.metrics.gross_profit_amount || 0);
    return {
      grossIncome,
      netIncome: Number(data.metrics.revenue_net_amount || 0),
      expense: Number(data.metrics.expense_amount || 0),
      grossProfit,
      grossProfitRate: grossIncome > 0 ? grossProfit / grossIncome : 0,
      netProfit: profit,
      profitRate: grossIncome > 0 ? profit / grossIncome : 0,
    };
  }, [data]);

  const categoryTreeData = useMemo<ExpenseCategoryTreeRow[]>(() => {
    if (!data) return [];
    const roots = new Map<string, ExpenseCategoryTreeRow>();
    data.metrics.expense_category_summary.forEach((item) => {
      const [rootName, childName] = item.name.split(" / ");
      const root = roots.get(rootName) ?? {
        key: rootName,
        name: rootName,
        amount: "0",
        item_count: 0,
        children: [],
      };
      root.amount = String(Number(root.amount) + Number(item.amount || 0));
      root.item_count += item.item_count;
      if (childName) {
        root.children!.push({
          key: item.name,
          name: childName,
          amount: item.amount,
          item_count: item.item_count,
        });
      }
      roots.set(rootName, root);
    });
    return [...roots.values()]
      .map((root) => ({
        ...root,
        children: root.children?.sort((left, right) => Number(right.amount) - Number(left.amount)),
      }))
      .sort((left, right) => Number(right.amount) - Number(left.amount));
  }, [data]);

  const categoryColumns = [
    { title: "分类", dataIndex: "name", ellipsis: true },
    {
      title: "金额",
      dataIndex: "amount",
      align: "right" as const,
      render: (value: string) => <MoneyDisplay value={Number(value || 0)} colorize />,
    },
    { title: "条数", dataIndex: "item_count", width: 90, align: "right" as const },
  ];

  async function openClosePreview() {
    if (!data?.selected_ledger) return;
    setIsClosing(true);
    setErrorMessage(null);
    try {
      const check = await apiClient.ledgers.closeCheck(data.selected_ledger.id);
      setClosePreview({ ledger: data.selected_ledger, check });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法预检封账");
    } finally {
      setIsClosing(false);
    }
  }

  async function confirmCloseLedger() {
    if (!closePreview?.check?.can_close) return;
    setIsClosing(true);
    try {
      await apiClient.ledgers.close(closePreview.ledger.id, "admin");
      setClosePreview(null);
      message.success("已封账");
      const workspace = await apiClient.storeLedgers.workspace(storeId, `?period=${period}`);
      setData(workspace);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法封账");
    } finally {
      setIsClosing(false);
    }
  }

  return (
    <AppShell title={`${storeName} · 总览`}>
      <Space direction="vertical" size={12} style={{ width: "100%", display: "flex" }}>
        {errorMessage ? <Alert message="加载失败" description={errorMessage} type="error" showIcon closable /> : null}

        {data ? (
          <StoreLedgerWorkspaceNav
            storeId={storeId}
            storeName={data.store.name}
            period={data.period}
            periodOptions={data.ledgers.map((ledger) => ({ label: ledger.period, value: ledger.period }))}
            ledgerStatusLabel={data.selected_ledger?.status === "closed" ? "已封账" : data.selected_ledger ? "进行中" : undefined}
            activeKey="overview"
            extra={data.selected_ledger?.status !== "closed" ? <Button onClick={() => void openClosePreview()} loading={isClosing}>封账</Button> : undefined}
          />
        ) : null}

        {stats ? (
          <div className="store-ledger-report-metrics store-ledger-report-metrics--compact">
            {metricCard("经营收入", formatMoney(stats.grossIncome), "各渠道录入累计，按录入日期统计", <RiseOutlined />, "green")}
            {metricCard("营业实收", formatMoney(stats.netIncome), "录入时填写的实收金额汇总", <WalletOutlined />, "blue")}
            {metricCard("本期支出", formatMoney(stats.expense), "审批入账支出 + 当月手续费", <FallOutlined />, "red")}
            {metricCard("毛利", formatMoney(stats.grossProfit), "营业收入减食材成本", <FileTextOutlined />, stats.grossProfit >= 0 ? "green" : "red")}
            {metricCard("毛利率", `${(stats.grossProfitRate * 100).toFixed(2)}%`, "毛利 ÷ 营业收入", <FileTextOutlined />, "gold")}
            {metricCard("净利润", formatMoney(stats.netProfit), "营业收入减累计支出", <FileTextOutlined />, stats.netProfit >= 0 ? "green" : "red")}
            {metricCard("利润率", `${(stats.profitRate * 100).toFixed(2)}%`, "净利润 ÷ 营业收入", <FileTextOutlined />, "gold")}
          </div>
        ) : null}

        {data ? (
          <Row gutter={[12, 12]}>
            <Col xs={24}>
              <Card size="small" title="支出分类统计">
                <Table
                  rowKey={(item) => item.name}
                  columns={categoryColumns}
                  dataSource={categoryTreeData}
                  pagination={false}
                  size="small"
                />
              </Card>
            </Col>
          </Row>
        ) : isLoading ? (
          <Card loading />
        ) : (
          <Empty description="暂无数据" />
        )}
      </Space>

      <Modal
        title="封账预检"
        open={Boolean(closePreview)}
        onCancel={() => setClosePreview(null)}
        onOk={() => void confirmCloseLedger()}
        okButtonProps={{ disabled: !closePreview?.check?.can_close }}
        okText={closePreview?.check?.can_close ? "确认封账" : "暂不能封账"}
        cancelText="关闭"
        confirmLoading={isClosing}
      >
        {closePreview ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="门店">{data?.store.name ?? "未知门店"}</Descriptions.Item>
              <Descriptions.Item label="账期">{closePreview.ledger.period}</Descriptions.Item>
              <Descriptions.Item label="未付款支出">{closePreview.check.unpaid_expense_count}</Descriptions.Item>
              <Descriptions.Item label="未匹配流水">{closePreview.check.unmatched_bank_transaction_count}</Descriptions.Item>
              <Descriptions.Item label="营业收入记录">{closePreview.check.revenue_record_count}</Descriptions.Item>
              <Descriptions.Item label="未对账收入">{closePreview.check.unmatched_revenue_record_count}</Descriptions.Item>
              <Descriptions.Item label="未对账实收金额" span={2}>{formatMoney(closePreview.check.unmatched_revenue_amount)}</Descriptions.Item>
              <Descriptions.Item label="候选匹配" span={2}>{closePreview.check.candidate_match_count}</Descriptions.Item>
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
