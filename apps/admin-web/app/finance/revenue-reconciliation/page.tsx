"use client";

import { Alert, Button, Card, Checkbox, DatePicker, Empty, Input, Modal, Popconfirm, Select, Space, Splitter, Statistic, Table, Tabs, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
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
      (match.revenue_record_ids?.length
        ? match.revenue_record_ids.includes(record.id)
        : match.channel === record.channel &&
          match.revenue_start_date <= record.revenue_date &&
          match.revenue_end_date >= record.revenue_date),
  );
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

const DEFAULT_REVENUE_CHANNEL_NAMES = ["美团团购", "美团点评买单", "抖音团购", "扫码收款", "商场代金券"];

export default function RevenueReconciliationPage() {
  const searchParams = useClientSearchParams();
  const initialStoreId = searchParams.get("store_id") ?? undefined;
  const initialLedgerPeriod = searchParams.get("ledger_period") ?? undefined;
  const initialChannel = searchParams.get("channel") ?? undefined;
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [channels, setChannels] = useState<RevenueChannel[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [incomeBankTotal, setIncomeBankTotal] = useState(0);
  const [records, setRecords] = useState<RevenueRecord[]>([]);
  const [matches, setMatches] = useState<RevenueBankMatch[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>();
  const [selectedTransaction, setSelectedTransaction] = useState<BankTransaction | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>();
  const [revenueDateRange, setRevenueDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null]>([null, null]);
  const [isDateRangeModalOpen, setIsDateRangeModalOpen] = useState(false);
  const [dateRangeDraft, setDateRangeDraft] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null]>([null, null]);
  const [keyword, setKeyword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isMatchDataReady, setIsMatchDataReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [matchValidationMessage, setMatchValidationMessage] = useState<string | null>(null);
  const loadRequestIdRef = useRef(0);

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
  const revenueChannelCards = DEFAULT_REVENUE_CHANNEL_NAMES
    .map((channelName) => {
      const channelRecords = records.filter((record) => record.channel === channelName);
      const unmatchedChannelRecords = channelRecords.filter((record) => !isRevenueRecordCovered(record, matches.filter(isActiveMatch)));
      return {
        name: channelName,
        totalCount: channelRecords.length,
        unmatchedCount: unmatchedChannelRecords.length,
        totalAmount: channelRecords.reduce((sum, record) => sum + moneyValue(record.net_amount), 0),
        unmatchedAmount: unmatchedChannelRecords.reduce((sum, record) => sum + moneyValue(record.net_amount), 0),
        };
    })
    .filter((channel) => channel.totalCount > 0 || channel.unmatchedCount > 0);
  const selectedRecords = records
    .filter((record) => selectedRecordIds.includes(record.id))
    .sort((left, right) => left.revenue_date.localeCompare(right.revenue_date));
  const selectedAmount = selectedRecords.reduce((sum, record) => sum + moneyValue(record.net_amount), 0);
  const bankRemaining = selectedTransaction ? remainingAmount(selectedTransaction) : 0;
  const activeMatches = matches.filter(isActiveMatch);
  const unmatchedRecords = records.filter((record) => !isRevenueRecordCovered(record, activeMatches));
  const filteredRecords = unmatchedRecords
    .filter((record) => !channelFilter || record.channel === channelFilter)
    .filter((record) => {
      const [startDate, endDate] = revenueDateRange;
      if (!startDate || !endDate) return true;
      const value = dayjs(record.revenue_date);
      return (
        (value.isAfter(startDate, "day") || value.isSame(startDate, "day")) &&
        (value.isBefore(endDate, "day") || value.isSame(endDate, "day"))
      );
    })
    .filter((record) => {
      const text = keyword.trim().toLowerCase();
      if (!text) return true;
      return [record.revenue_date, record.channel, record.remark || ""].some((value) => value.toLowerCase().includes(text));
    })
    .sort((left, right) => left.revenue_date.localeCompare(right.revenue_date) || left.channel.localeCompare(right.channel));
  const matchedAmount = activeMatches.reduce((sum, match) => sum + moneyValue(match.amount), 0);
  const unmatchedAmount = unmatchedRecords.reduce((sum, record) => sum + moneyValue(record.net_amount), 0);
  const hiddenMatchedTransactionCount = Math.max(incomeBankTotal - transactions.length, 0);
  const matchActionHint = !selectedTransaction
    ? "先选择左侧收入银行流水"
    : !selectedRecordIds.length
      ? "再选择右侧营业收入"
      : `将确认 ${selectedRecordIds.length} 条，实收合计 ${formatMoney(selectedAmount.toFixed(2))}`;

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
      const requestId = ++loadRequestIdRef.current;
      setIsLoading(true);
      setErrorMessage(null);
      setIsMatchDataReady(false);
    try {
      const bankParams = new URLSearchParams({ store_id: storeId, direction: "income", page_size: "500" });
      const revenueParams = new URLSearchParams({ store_id: storeId, page_size: "500" });
      const matchParams = new URLSearchParams({ store_id: storeId, page_size: "500" });
      if (initialLedgerPeriod) {
        revenueParams.set("ledger_period", initialLedgerPeriod);
        matchParams.set("ledger_period", initialLedgerPeriod);
      }
      const results = await Promise.allSettled([
        apiClient.bankTransactions.list(`?${bankParams.toString()}`),
        apiClient.revenueRecords.list(`?${revenueParams.toString()}`),
        apiClient.matches.listRevenue(`?${matchParams.toString()}`),
      ]);

      if (requestId !== loadRequestIdRef.current) return;

      const [bankResult, revenueResult, matchResult] = results;
      const loadErrors: string[] = [];
      const nextTransactions = bankResult.status === "fulfilled"
        ? [...bankResult.value.items]
            .filter((transaction) => remainingAmount(transaction) > 0)
            .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
        : [];
      const nextRecords = revenueResult.status === "fulfilled" ? revenueResult.value.items : [];
      const nextMatches = matchResult.status === "fulfilled" ? matchResult.value.items : [];

      if (bankResult.status === "rejected") loadErrors.push("收入银行流水");
      if (revenueResult.status === "rejected") loadErrors.push("营业收入");
      if (matchResult.status === "rejected") loadErrors.push("收入匹配记录");

      setTransactions(nextTransactions);
      setIncomeBankTotal(bankResult.status === "fulfilled" ? bankResult.value.total : 0);
      setRecords(nextRecords);
      setMatches(nextMatches);
      setIsMatchDataReady(matchResult.status === "fulfilled");
      const kept = keepTransactionId ? nextTransactions.find((transaction) => transaction.id === keepTransactionId) : null;
      const nextSelected = kept && remainingAmount(kept) > 0
        ? kept
        : nextTransactions.find((transaction) => remainingAmount(transaction) > 0) ?? null;
      setSelectedTransaction(nextSelected);
      setSelectedRecordIds([]);
      if (loadErrors.length) {
        setErrorMessage(`收入对账部分数据加载失败：${loadErrors.join("、")}。请刷新后重试。`);
      }
    } catch (error) {
      if (requestId === loadRequestIdRef.current) {
        setErrorMessage(error instanceof Error ? error.message : "无法加载收入对账数据");
      }
    } finally {
      if (requestId === loadRequestIdRef.current) setIsLoading(false);
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
    if (!isMatchDataReady) {
      message.warning("收入匹配数据还在加载，请稍后再选");
      return;
    }
    if (isRevenueRecordCovered(record, activeMatches)) return;
    setMatchValidationMessage(null);
    setSelectedRecordIds((current) =>
      current.includes(record.id) ? current.filter((id) => id !== record.id) : [...current, record.id],
    );
  }

  function openDateRangeModal() {
    setDateRangeDraft(revenueDateRange);
    setIsDateRangeModalOpen(true);
  }

  function confirmDateRangeSelection() {
    const [startDate, endDate] = dateRangeDraft;
    if (!startDate || !endDate) {
      message.warning("请先选择日期范围");
      return;
    }
    setRevenueDateRange([startDate, endDate]);
    const selected = unmatchedRecords
      .filter((record) => !channelFilter || record.channel === channelFilter)
      .filter((record) => {
        const value = dayjs(record.revenue_date);
        return (
          (value.isAfter(startDate, "day") || value.isSame(startDate, "day")) &&
          (value.isBefore(endDate, "day") || value.isSame(endDate, "day"))
        );
      })
      .map((record) => record.id);
    if (!selected.length) {
      message.warning("该日期范围内没有可匹配的营业收入");
      return;
    }
    setSelectedRecordIds(selected);
    message.success(`已选中 ${selected.length} 条营业收入`);
    setIsDateRangeModalOpen(false);
  }

  function clearSelectedRecords() {
    setMatchValidationMessage(null);
    setSelectedRecordIds([]);
  }

  function validateSelection() {
    if (!selectedTransaction) {
      setMatchValidationMessage("请先选择左侧收入银行流水。");
      return null;
    }
    if (!selectedRecords.length) {
      setMatchValidationMessage("请选择右侧要匹配的营业收入。");
      return null;
    }
    const startDate = selectedRecords[0].revenue_date;
    const endDate = selectedRecords[selectedRecords.length - 1].revenue_date;
    if (!Number.isFinite(selectedAmount) || selectedAmount <= 0) {
      setMatchValidationMessage("选中收入实收合计必须大于 0。");
      return null;
    }
    if (selectedAmount > bankRemaining + 0.005) {
      setMatchValidationMessage(
        `选中收入合计 ${formatMoney(selectedAmount.toFixed(2))} 不能超过银行流水剩余金额 ${formatMoney(bankRemaining.toFixed(2))}。`,
      );
      return null;
    }
    setMatchValidationMessage(null);
    return {
      startDate,
      endDate,
      amount: selectedAmount,
      revenueRecordIds: selectedRecords.map((record) => record.id),
    };
  }

  async function confirmMatch() {
    const storeId = selectedStoreId ?? initialStoreId;
    if (!storeId) {
      setMatchValidationMessage("请先选择门店。");
      return;
    }
    if (!selectedTransaction) {
      setMatchValidationMessage("请先选择左侧收入银行流水。");
      return;
    }
    const selection = validateSelection();
    if (!selection) return;
    setIsSaving(true);
    setSubmitStatus("正在提交收入匹配");
    message.loading({ content: "正在提交收入匹配", key: "revenue-match-submit", duration: 0 });
    try {
      await apiClient.matches.createRevenueBatch({
        bank_transaction_id: selectedTransaction.id,
        amount: selection.amount.toFixed(2),
        accounting_period: initialLedgerPeriod || selectedTransaction.ledger_period,
        revenue_record_ids: selection.revenueRecordIds,
        confidence: "100.00",
        reason: "营业收入记录手动关联银行流水",
      });
      setSubmitStatus(`已选中 ${selection.revenueRecordIds.length} 条营业收入，正在刷新`);
      await loadStoreWorkspace(storeId, selectedTransaction.id);
      setSubmitStatus(`收入对账已确认，已关联 ${selection.revenueRecordIds.length} 条营业收入`);
      message.success({ content: `已确认匹配 ${selection.revenueRecordIds.length} 条营业收入`, key: "revenue-match-submit" });
    } catch (error) {
      setSubmitStatus(null);
      message.destroy("revenue-match-submit");
      message.error(error instanceof Error ? error.message : "确认收入对账失败");
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
          <Typography.Text type="secondary">
            {match.revenue_start_date} 至 {match.revenue_end_date}
            {match.revenue_record_ids?.length ? ` / ${match.revenue_record_ids.length} 条收入` : ""}
          </Typography.Text>
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
    <AppShell title={currentStore?.name ? `${currentStore.name} · 收入对账` : "收入对账"} kicker={initialLedgerPeriod ? `账期：${initialLedgerPeriod}` : undefined}>
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
	                    title="可匹配收入银行流水"
	                    className="data-table-card bank-transaction-panel"
	                    extra={
	                      <Space size={8} wrap>
	                        <Typography.Text type="secondary">可对账 {transactions.length} 条</Typography.Text>
	                        <Typography.Text type="secondary">收入流水总数 {incomeBankTotal} 条</Typography.Text>
	                        {hiddenMatchedTransactionCount ? (
	                          <Typography.Text type="secondary">已全额匹配隐藏 {hiddenMatchedTransactionCount} 条</Typography.Text>
	                        ) : null}
	                      </Space>
	                    }
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
	                                setMatchValidationMessage(null);
	                              }}
                            >
                              <span className="bank-transaction-card__main">
                                <span className="bank-transaction-card__meta">
                                  <Typography.Text strong>{dayjs(transaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
                                  <Tag color="default" style={{ color: '#333', backgroundColor: '#f0f0f0' }}>💰 收入</Tag>
                                  {transaction.ledger_period ? <Tag color="default" style={{ color: '#666', backgroundColor: '#f5f5f5' }}>{transaction.ledger_period}</Tag> : null}
                                  {isFullyMatched ? <Tag color="success">✓ 已匹配</Tag> : <Tag color="warning">⧗ 待匹配</Tag>}
                                </span>
                                <Typography.Text className="bank-transaction-card__summary" ellipsis>
                                  {transaction.summary || transaction.counterparty_name || "无摘要"}
                                </Typography.Text>
                                {transaction.bank_serial_no ? (
                                  <span className="bank-transaction-card__serial">流水号 {transaction.bank_serial_no}</span>
                                ) : null}
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
	                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedStoreId ? "当前门店暂无可匹配收入银行流水" : "请先选择门店"} />
	                    )}
                  </Card>
                </Splitter.Panel>
                <Splitter.Panel min="520px">
                  <Card
                    title={selectedTransaction
                      ? `营业收入候选 (${filteredRecords.length})：流水剩余 ${formatMoney(bankRemaining.toFixed(2))}${selectedRecordIds.length ? `，已选 ${selectedRecordIds.length} 条` : ""}`
                      : `营业收入候选 (${filteredRecords.length})`}
                    className="data-table-card approval-candidate-panel"
                    extra={
                      <Space>
                        <DatePicker.RangePicker
                          allowClear
                          value={revenueDateRange}
                          onChange={(dates) => setRevenueDateRange((dates as [dayjs.Dayjs | null, dayjs.Dayjs | null]) ?? [null, null])}
                        />
                        <Input allowClear placeholder="日期 / 渠道 / 备注" style={{ width: 180 }} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
                      </Space>
                    }
                  >
                    <div className="revenue-match-summary">
                      <Statistic title={`待匹配收入 (${unmatchedRecords.length} 条)`} value={formatMoney(unmatchedAmount.toFixed(2))} valueStyle={{ color: '#faad14' }} />
                      <Statistic title="已选实收" value={formatMoney(selectedAmount.toFixed(2))} valueStyle={{ color: '#1890ff' }} />
                      <Statistic title="差额" value={formatMoney((bankRemaining - selectedAmount).toFixed(2))} valueStyle={{ color: (bankRemaining - selectedAmount) === 0 ? '#52c41a' : '#ff4d4f' }} />
                      <Statistic title="已对账金额" value={formatMoney(matchedAmount.toFixed(2))} valueStyle={{ color: '#52c41a' }} />
                    </div>
	                    {submitStatus ? <Alert className="dashboard-alert" type="info" showIcon message={submitStatus} /> : null}
                    {matchValidationMessage ? <Alert className="dashboard-alert" type="warning" showIcon message={matchValidationMessage} /> : null}
                    <div className="revenue-channel-toolbar">
                      <div className="revenue-channel-grid">
                        {revenueChannelCards.map((channel) => {
                          const isSelected = channel.name === channelFilter;
                          return (
                            <button
                              key={channel.name}
                              type="button"
                              className={`revenue-channel-card${isSelected ? " is-selected" : ""}`}
                              onClick={() => setChannelFilter(isSelected ? undefined : channel.name)}
                            >
                              <span className="revenue-channel-card__main">
                                <Typography.Text strong>{channel.name}</Typography.Text>
                                <Typography.Text type="secondary">
                                  {channel.unmatchedCount} 条未匹配 / {formatMoney(channel.unmatchedAmount.toFixed(2))}
                                </Typography.Text>
                              </span>
                              <span className="revenue-channel-card__aside">
                                <Tag color={isSelected ? "blue" : "default"}>{isSelected ? "已选" : `${channel.totalCount} 条`}</Tag>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <Space>
                        <Typography.Text strong style={{ fontSize: '14px', color: '#262626' }}>
                          📋 操作指引：
                        </Typography.Text>
                        <Typography.Text
                          type={selectedTransaction ? (selectedRecordIds.length > 0 ? "success" : "warning") : "secondary"}
                          style={{ fontSize: '13px' }}
                        >
                          {matchActionHint}
                        </Typography.Text>
                      </Space>
                      <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <Button type="primary" loading={isSaving} disabled={isSaving || !selectedTransaction || !selectedRecordIds.length} onClick={() => void confirmMatch()}>
                          ✓ 确认匹配
                        </Button>
                        <Button onClick={openDateRangeModal} disabled={!isMatchDataReady || !selectedTransaction}>
                          📅 按日期范围选中
                        </Button>
                        <Button onClick={clearSelectedRecords} disabled={!selectedRecordIds.length}>
                          🗑️ 清空选择
                        </Button>
                        <Button onClick={() => setChannelFilter(undefined)} disabled={!channelFilter}>
                          🔄 清除渠道筛选
                        </Button>
                      </div>
                    </div>
	                    {!transactions.length && unmatchedRecords.length ? (
	                      <Alert
	                        className="dashboard-alert"
	                        type="info"
	                        showIcon
	                        message={`当前没有可匹配收入银行流水，已加载 ${unmatchedRecords.length} 条待匹配营业收入`}
	                        description={
	                          hiddenMatchedTransactionCount
	                            ? `已加载 ${incomeBankTotal} 条收入银行流水，其中 ${hiddenMatchedTransactionCount} 条已全额匹配并隐藏。左侧只显示仍有剩余金额的收入流水。`
	                            : "请先到“银行流水”页面录入或导入类型为收入、且仍有未匹配余额的流水，之后返回这里进行匹配。"
	                        }
	                      />
	                    ) : null}
                    {filteredRecords.length ? (
                      <div className="approval-candidate-list revenue-candidate-list">
                        {filteredRecords.map((record) => {
                          const isSelected = selectedRecordIds.includes(record.id);
                          const canSelect = !isRevenueRecordCovered(record, activeMatches);
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
                              style={{
                                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                                backgroundColor: isSelected ? '#f6ffed' : !canSelect ? '#fafafa' : '#ffffff',
                                borderLeft: isSelected ? '4px solid #52c41a' : '4px solid #d9d9d9',
                                borderRadius: '4px',
                                opacity: !canSelect ? 0.6 : 1,
                                boxShadow: isSelected ? '0 2px 8px rgba(82, 196, 26, 0.15)' : 'none',
                                cursor: canSelect ? 'pointer' : 'not-allowed',
                              }}
                            >
                              <div className="revenue-candidate-card__check">
                                <Checkbox
                                  checked={isSelected}
                                  disabled={!canSelect || !isMatchDataReady}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={() => toggleRecord(record)}
                                />
                              </div>
                              <div className="approval-candidate-card__main">
                                <Space size={6} wrap>
                                  <Typography.Text strong>{record.revenue_date}</Typography.Text>
                                  <Tag color="blue">{record.channel}</Tag>
                                  <Tag color="default" style={{ color: '#666', backgroundColor: '#f5f5f5' }}>{record.ledger_period}</Tag>
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

      <Modal
        title="按日期范围选中营业收入"
        open={isDateRangeModalOpen}
        onCancel={() => setIsDateRangeModalOpen(false)}
        onOk={confirmDateRangeSelection}
        okText="确认选中"
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Text type="secondary">先选起止日期，再确认选中该范围内的未匹配收入。</Typography.Text>
          <DatePicker.RangePicker
            style={{ width: "100%" }}
            value={dateRangeDraft}
            onChange={(dates) => setDateRangeDraft((dates as [dayjs.Dayjs | null, dayjs.Dayjs | null]) ?? [null, null])}
          />
        </Space>
      </Modal>
    </AppShell>
  );
}
