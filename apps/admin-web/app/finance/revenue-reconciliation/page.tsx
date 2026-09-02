"use client";

import { Alert, Button, Card, Checkbox, Empty, Input, Popconfirm, Select, Space, Splitter, Statistic, Table, Tabs, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type { BankTransaction, Ledger, RevenueBankMatch, RevenueChannel, RevenueRecord, Store } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { getLedgers, getRevenueChannels, getStores } from "../../lib/referenceData";
import { useClientSearchParams } from "../../lib/searchParams";

function remainingAmount(transaction: BankTransaction) {
  return Number(transaction.amount) - Number(transaction.matched_amount || 0);
}

function moneyValue(value?: string | number | null) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function isActiveMatch(match: RevenueBankMatch) {
  return match.status !== "rejected";
}

function isRevenueRecordCovered(record: RevenueRecord, matches: RevenueBankMatch[]) {
  return matches.some(
    (match) =>
      isActiveMatch(match) &&
      match.channel === record.channel &&
      match.revenue_start_date <= record.revenue_date &&
      match.revenue_end_date >= record.revenue_date,
  );
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

export default function RevenueReconciliationPage() {
  const searchParams = useClientSearchParams();
  const initialStoreId = searchParams.get("store_id") ?? undefined;
  const initialLedgerPeriod = searchParams.get("ledger_period") ?? undefined;
  const initialChannel = searchParams.get("channel") ?? undefined;
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [channels, setChannels] = useState<RevenueChannel[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [records, setRecords] = useState<RevenueRecord[]>([]);
  const [matches, setMatches] = useState<RevenueBankMatch[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>();
  const [selectedTransaction, setSelectedTransaction] = useState<BankTransaction | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>();
  const [keyword, setKeyword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const transactionsById = useMemo(() => new Map(transactions.map((transaction) => [transaction.id, transaction])), [transactions]);
  const currentStore = selectedStoreId ? storesById.get(selectedStoreId) : undefined;
  const ledgerPeriodOptions = Array.from(new Set(ledgers.map((ledger) => ledger.period)))
    .sort()
    .reverse()
    .map((period) => ({ label: period, value: period }));
  const currentLedger = selectedStoreId && initialLedgerPeriod
    ? ledgers.find((ledger) => ledger.store_id === selectedStoreId && ledger.period === initialLedgerPeriod)
    : undefined;
  const channelOptions = Array.from(new Set([...channels.map((channel) => channel.name), ...records.map((record) => record.channel)]))
    .filter(Boolean)
    .sort()
    .map((channel) => ({ label: channel, value: channel }));
  const selectedRecords = records
    .filter((record) => selectedRecordIds.includes(record.id))
    .sort((left, right) => left.revenue_date.localeCompare(right.revenue_date));
  const selectedAmount = selectedRecords.reduce((sum, record) => sum + moneyValue(record.net_amount), 0);
  const selectedChannel = selectedRecords[0]?.channel;
  const bankRemaining = selectedTransaction ? remainingAmount(selectedTransaction) : 0;
  const activeMatches = matches.filter(isActiveMatch);
  const unmatchedRecords = records.filter((record) => !isRevenueRecordCovered(record, activeMatches));
  const filteredRecords = unmatchedRecords
    .filter((record) => !channelFilter || record.channel === channelFilter)
    .filter((record) => {
      const text = keyword.trim().toLowerCase();
      if (!text) return true;
      return [record.revenue_date, record.channel, record.remark || ""].some((value) => value.toLowerCase().includes(text));
    })
    .sort((left, right) => left.revenue_date.localeCompare(right.revenue_date) || left.channel.localeCompare(right.channel));
  const matchedAmount = activeMatches.reduce((sum, match) => sum + moneyValue(match.amount), 0);
  const unmatchedAmount = unmatchedRecords.reduce((sum, record) => sum + moneyValue(record.net_amount), 0);

  async function loadBaseData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage, channelPage] = await Promise.all([
        getStores(),
        getLedgers(),
        getRevenueChannels(),
      ]);
      setStores(storePage);
      setLedgers(ledgerPage);
      setChannels(channelPage);
      if (!selectedStoreId) {
        const defaultStoreId = initialStoreId && storePage.some((store) => store.id === initialStoreId)
          ? initialStoreId
          : storePage[0]?.id;
        if (defaultStoreId) setSelectedStoreId(defaultStoreId);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载基础数据");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadStoreWorkspace(storeId: string, keepTransactionId?: string) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const bankParams = new URLSearchParams({ store_id: storeId, direction: "income", page_size: "500" });
      const revenueParams = new URLSearchParams({ store_id: storeId, page_size: "500" });
      const matchParams = new URLSearchParams({ store_id: storeId, page_size: "500" });
      if (initialLedgerPeriod) {
        bankParams.set("ledger_period", initialLedgerPeriod);
        revenueParams.set("ledger_period", initialLedgerPeriod);
        matchParams.set("ledger_period", initialLedgerPeriod);
      }
      const [bankPage, revenuePage, matchPage] = await Promise.all([
        apiClient.bankTransactions.list(`?${bankParams.toString()}`),
        apiClient.revenueRecords.list(`?${revenueParams.toString()}`),
        apiClient.matches.listRevenue(`?${matchParams.toString()}`),
      ]);
      const nextTransactions = bankPage.items.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
      setTransactions(nextTransactions);
      setRecords(revenuePage.items);
      setMatches(matchPage.items);
      const kept = keepTransactionId ? nextTransactions.find((transaction) => transaction.id === keepTransactionId) : null;
      const nextSelected = kept && remainingAmount(kept) > 0
        ? kept
        : nextTransactions.find((transaction) => remainingAmount(transaction) > 0) ?? null;
      setSelectedTransaction(nextSelected);
      setSelectedRecordIds([]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载收入对账数据");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadBaseData();
  }, []);

  useEffect(() => {
    if (initialStoreId) setSelectedStoreId(initialStoreId);
  }, [initialStoreId]);

  useEffect(() => {
    setChannelFilter(initialChannel);
  }, [initialChannel]);

  useEffect(() => {
    if (selectedStoreId) void loadStoreWorkspace(selectedStoreId, selectedTransaction?.id);
  }, [selectedStoreId, initialLedgerPeriod]);

  function toggleRecord(record: RevenueRecord) {
    if (isRevenueRecordCovered(record, activeMatches)) return;
    if (selectedChannel && selectedChannel !== record.channel && !selectedRecordIds.includes(record.id)) {
      message.warning("一次匹配只能选择同一个收入渠道");
      return;
    }
    setSelectedRecordIds((current) =>
      current.includes(record.id) ? current.filter((id) => id !== record.id) : [...current, record.id],
    );
  }

  function validateSelection() {
    if (!selectedTransaction) {
      message.warning("请先选择收入银行流水");
      return null;
    }
    if (!selectedRecords.length) {
      message.warning("请选择要匹配的营业收入");
      return null;
    }
    const channel = selectedRecords[0].channel;
    if (selectedRecords.some((record) => record.channel !== channel)) {
      message.warning("一次匹配只能选择同一个收入渠道");
      return null;
    }
    const startDate = selectedRecords[0].revenue_date;
    const endDate = selectedRecords[selectedRecords.length - 1].revenue_date;
    const hasMatchedOverlap = activeMatches.some(
      (match) =>
        match.channel === channel &&
        match.revenue_start_date <= endDate &&
        match.revenue_end_date >= startDate,
    );
    if (hasMatchedOverlap) {
      message.warning("所选日期范围内已经存在已对账收入，请调整选择范围");
      return null;
    }
    const rangeRecords = unmatchedRecords
      .filter((record) => record.channel === channel && record.revenue_date >= startDate && record.revenue_date <= endDate)
      .sort((left, right) => left.revenue_date.localeCompare(right.revenue_date));
    const selectedIdSet = new Set(selectedRecords.map((record) => record.id));
    if (rangeRecords.length !== selectedRecords.length || rangeRecords.some((record) => !selectedIdSet.has(record.id))) {
      message.warning("多条收入匹配需要选择连续日期范围内的全部未对账收入");
      return null;
    }
    if (!Number.isFinite(selectedAmount) || selectedAmount <= 0) {
      message.warning("选中收入实收合计必须大于 0");
      return null;
    }
    if (selectedAmount > bankRemaining + 0.005) {
      message.warning("选中收入合计不能超过银行流水剩余金额");
      return null;
    }
    return { channel, startDate, endDate, amount: selectedAmount };
  }

  async function confirmMatch() {
    if (!selectedStoreId || !selectedTransaction) return;
    const selection = validateSelection();
    if (!selection) return;
    setIsSaving(true);
    try {
      const match = await apiClient.matches.createRevenue({
        bank_transaction_id: selectedTransaction.id,
        channel: selection.channel,
        revenue_start_date: selection.startDate,
        revenue_end_date: selection.endDate,
        amount: selection.amount.toFixed(2),
        confidence: "100.00",
        reason: "营业收入记录手动关联银行流水",
      });
      await apiClient.matches.confirmRevenue(match.id, "admin");
      message.success("收入对账已确认");
      await loadStoreWorkspace(selectedStoreId, selectedTransaction.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "确认收入对账失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function unmatchRevenue(match: RevenueBankMatch) {
    if (!selectedStoreId) return;
    setIsSaving(true);
    try {
      await apiClient.matches.unmatchRevenue(match.id);
      message.success("收入匹配已解除");
      await loadStoreWorkspace(selectedStoreId, selectedTransaction?.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "解除收入匹配失败");
    } finally {
      setIsSaving(false);
    }
  }

  const matchColumns: ColumnsType<RevenueBankMatch> = [
    {
      title: "收入范围",
      width: 220,
      render: (_, match) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{match.channel}</Typography.Text>
          <Typography.Text type="secondary">{match.revenue_start_date} 至 {match.revenue_end_date}</Typography.Text>
        </Space>
      ),
    },
    { title: "匹配金额", dataIndex: "amount", width: 120, align: "right", render: (value: string) => formatMoney(value) },
    {
      title: "银行流水",
      width: 320,
      render: (_, match) => {
        const transaction = transactionsById.get(match.bank_transaction_id);
        return transaction ? (
          <Space direction="vertical" size={2} style={{ width: "100%" }}>
            <Space size={6} wrap>
              <Typography.Text strong>{dayjs(transaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
              <Typography.Text className="income-amount">{formatMoney(transaction.amount)}</Typography.Text>
              {transaction.bank_serial_no ? <Tag>{transaction.bank_serial_no}</Tag> : null}
            </Space>
            <Typography.Text ellipsis>{transaction.summary || transaction.counterparty_name || "无摘要"}</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">{match.bank_transaction_id}</Typography.Text>
        );
      },
    },
    { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "confirmed" ? "green" : "gold"}>{value === "confirmed" ? "已确认" : "候选"}</Tag> },
    { title: "确认人", dataIndex: "confirmed_by", width: 110, render: (value?: string | null) => value || "-" },
    { title: "确认时间", dataIndex: "confirmed_at", width: 150, render: formatDateTime },
    {
      title: "操作",
      width: 100,
      fixed: "right",
      render: (_, match) => (
        <Popconfirm
          title="解除收入匹配？"
          description="解除后银行流水会恢复可匹配金额，收入记录会回到候选列表。"
          okText="解除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => unmatchRevenue(match)}
        >
          <Button type="link" size="small" danger disabled={match.status !== "confirmed" || isSaving}>
            解除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <AppShell title="收入对账">
      {initialStoreId ? (
        <StoreLedgerWorkspaceNav
          storeId={selectedStoreId ?? initialStoreId}
          storeName={currentStore?.name}
          period={initialLedgerPeriod}
          periodOptions={ledgerPeriodOptions}
          statusLabel={currentStore?.status === "active" ? "启用门店" : currentStore ? "停用门店" : undefined}
          ledgerStatusLabel={currentLedger?.status === "closed" ? "已封账" : currentLedger ? "进行中" : undefined}
          activeKey="revenueMatching"
        />
      ) : null}
      {errorMessage ? <Alert className="dashboard-alert" type="warning" showIcon message={errorMessage} closable onClose={() => setErrorMessage(null)} /> : null}

      {!initialStoreId ? (
        <Card className="reconciliation-summary-card">
          <div className="reconciliation-summary-card__main">
            <div className="reconciliation-summary-card__store">
              <Typography.Text className="reconciliation-summary-card__label">当前门店</Typography.Text>
              <Select
                showSearch
                optionFilterProp="label"
                className="reconciliation-summary-card__select"
                value={selectedStoreId}
                onChange={setSelectedStoreId}
                options={stores.map((store) => ({ label: store.name, value: store.id }))}
              />
            </div>
            <div className="reconciliation-summary-card__metrics">
              <Statistic title="收入流水" value={transactions.length} />
              <Statistic title="未对账收入" value={unmatchedRecords.length} />
              <Statistic title="已对账" value={matches.length} />
            </div>
          </div>
          <Space className="reconciliation-summary-card__actions">
            <Button onClick={() => selectedStoreId && loadStoreWorkspace(selectedStoreId)}>刷新</Button>
          </Space>
        </Card>
      ) : null}

      <Tabs
        className="reconciliation-tabs"
        defaultActiveKey="workbench"
        items={[
          {
            key: "workbench",
            label: `匹配工作台 (${transactions.length})`,
            children: (
              <Splitter className="reconciliation-workbench">
                <Splitter.Panel defaultSize="34%" min="300px">
                  <Card
                    title="收入银行流水"
                    className="data-table-card bank-transaction-panel"
                    extra={<Typography.Text type="secondary">共 {transactions.length} 条</Typography.Text>}
                  >
                    {transactions.length ? (
                      <div className="bank-transaction-list">
                        {transactions.map((transaction) => {
                          const remaining = remainingAmount(transaction);
                          const isSelected = transaction.id === selectedTransaction?.id;
                          const isFullyMatched = remaining <= 0;
                          return (
                            <button
                              key={transaction.id}
                              type="button"
                              className={`bank-transaction-card${isSelected ? " is-selected" : ""}${isFullyMatched ? " is-disabled" : ""}`}
                              disabled={isFullyMatched}
                              onClick={() => {
                                setSelectedTransaction(transaction);
                                setSelectedRecordIds([]);
                              }}
                            >
                              <span className="bank-transaction-card__main">
                                <span className="bank-transaction-card__meta">
                                  <Typography.Text strong>{dayjs(transaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
                                  <Tag color="green">收入</Tag>
                                  {transaction.ledger_period ? <Tag>{transaction.ledger_period}</Tag> : null}
                                  {isFullyMatched ? <Tag color="green">已匹配</Tag> : <Tag>待匹配</Tag>}
                                </span>
                                <Typography.Text className="bank-transaction-card__summary" ellipsis>
                                  {transaction.summary || transaction.counterparty_name || "无摘要"}
                                </Typography.Text>
                                <span className="bank-transaction-card__serial">
                                  {transaction.bank_serial_no ? `流水号 ${transaction.bank_serial_no}` : "未填写流水号"}
                                </span>
                              </span>
                              <span className="bank-transaction-card__amounts">
                                <Typography.Text className="bank-transaction-card__amount income-amount">{formatMoney(transaction.amount)}</Typography.Text>
                                <Typography.Text type="secondary">剩余 {formatMoney(Math.max(remaining, 0).toFixed(2))}</Typography.Text>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedStoreId ? "当前门店当前账期暂无收入方向银行流水" : "请先选择门店"} />
                    )}
                  </Card>
                </Splitter.Panel>
                <Splitter.Panel min="520px">
                  <Card
                    title={selectedTransaction ? `营业收入候选：流水剩余 ${formatMoney(bankRemaining.toFixed(2))}` : "营业收入候选"}
                    className="data-table-card approval-candidate-panel"
                    extra={
                      <Space>
                        <Select allowClear placeholder="渠道" style={{ width: 150 }} options={channelOptions} value={channelFilter} onChange={setChannelFilter} />
                        <Input allowClear placeholder="日期 / 渠道 / 备注" style={{ width: 180 }} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
                        <Button type="primary" loading={isSaving} disabled={!selectedTransaction || !selectedRecordIds.length} onClick={confirmMatch}>
                          确认匹配
                        </Button>
                      </Space>
                    }
                  >
                    <div className="revenue-match-summary">
                      <Statistic title="未对账实收" value={formatMoney(unmatchedAmount.toFixed(2))} />
                      <Statistic title="已选实收" value={formatMoney(selectedAmount.toFixed(2))} />
                      <Statistic title="差额" value={formatMoney((bankRemaining - selectedAmount).toFixed(2))} />
                      <Statistic title="已对账金额" value={formatMoney(matchedAmount.toFixed(2))} />
                    </div>
                    {filteredRecords.length ? (
                      <div className="approval-candidate-list revenue-candidate-list">
                        {filteredRecords.map((record) => {
                          const isSelected = selectedRecordIds.includes(record.id);
                          const canSelect = !selectedChannel || selectedChannel === record.channel || isSelected;
                          return (
                            <div
                              key={record.id}
                              role="button"
                              tabIndex={0}
                              className={`approval-candidate-card revenue-candidate-card${isSelected ? " is-selected" : ""}${!canSelect ? " is-disabled" : ""}`}
                              onClick={() => toggleRecord(record)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") toggleRecord(record);
                              }}
                            >
                              <div className="revenue-candidate-card__check">
                                <Checkbox
                                  checked={isSelected}
                                  disabled={!canSelect}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={() => toggleRecord(record)}
                                />
                              </div>
                              <div className="approval-candidate-card__main">
                                <Space size={6} wrap>
                                  <Typography.Text strong>{record.revenue_date}</Typography.Text>
                                  <Tag color="blue">{record.channel}</Tag>
                                  <Tag>{record.ledger_period}</Tag>
                                </Space>
                                <Typography.Text className="approval-candidate-card__title" ellipsis>
                                  {record.remark || "无备注"}
                                </Typography.Text>
                                <Space size={[12, 4]} wrap className="approval-candidate-card__meta">
                                  <span>经营收入 {formatMoney(record.gross_amount)}</span>
                                  <span>手续费 {formatMoney(record.fee_amount)}</span>
                                </Space>
                              </div>
                              <div className="approval-candidate-card__aside">
                                <Typography.Text className="approval-candidate-card__amount income-amount">{formatMoney(record.net_amount)}</Typography.Text>
                                <Typography.Text type="secondary">实收金额</Typography.Text>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedStoreId ? "当前门店暂无可匹配营业收入" : "请先选择门店"} />
                    )}
                  </Card>
                </Splitter.Panel>
              </Splitter>
            ),
          },
          {
            key: "records",
            label: `已对账记录 (${activeMatches.length})`,
            children: (
              <Card title="收入对账记录" className="data-table-card reconciliation-record-card">
                <Table
                  rowKey="id"
                  size="small"
                  loading={isLoading}
                  columns={matchColumns}
                  dataSource={activeMatches}
                  pagination={{ pageSize: 12 }}
                  scroll={{ x: 1120, y: "calc(100vh - 430px)" }}
                  sticky
                />
              </Card>
            ),
          },
        ]}
      />
    </AppShell>
  );
}
