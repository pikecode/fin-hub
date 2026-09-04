"use client";

import { Alert, Button, Card, DatePicker, Empty, Modal, Popconfirm, Select, Space, Statistic, Table, Tabs, Tag, Typography, message } from "antd";
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

const DEFAULT_REVENUE_CHANNEL_NAMES = ["美团团购", "美团点评买单", "抖音团购", "扫码收款", "商场代金券", "现金收款", "淘宝团购"];

function defaultLedgerPeriod() {
  return dayjs().subtract(1, "month").format("YYYY-MM");
}

function normalizeDateRange(
  dates: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null,
): [dayjs.Dayjs | null, dayjs.Dayjs | null] {
  return dates ?? [null, null];
}

function isCompleteDateRange(dates: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null) {
  return Boolean(dates?.[0] && dates?.[1]);
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
  const [incomeBankTotal, setIncomeBankTotal] = useState(0);
  const [records, setRecords] = useState<RevenueRecord[]>([]);
  const [matches, setMatches] = useState<RevenueBankMatch[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>();
  const [selectedTransaction, setSelectedTransaction] = useState<BankTransaction | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>();
  const [revenueDateRange, setRevenueDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null]>([null, null]);
  const [isMatchModalOpen, setIsMatchModalOpen] = useState(false);
  const [matchChannelNames, setMatchChannelNames] = useState<string[]>([]);
  const [matchDateRange, setMatchDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null]>([null, null]);
  const [matchModalSelectedRecordIds, setMatchModalSelectedRecordIds] = useState<string[]>([]);
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
  const fallbackLedgerPeriod = useMemo(() => defaultLedgerPeriod(), []);
  const selectedLedgerPeriod = initialLedgerPeriod ?? fallbackLedgerPeriod;
  const ledgerPeriodOptions = useMemo(() => {
    const periods = new Set(ledgers.map((ledger) => ledger.period));
    if (selectedLedgerPeriod) periods.add(selectedLedgerPeriod);
    return Array.from(periods)
      .sort()
      .reverse()
      .map((period) => ({ label: period, value: period }));
  }, [ledgers, selectedLedgerPeriod]);
  const currentLedger = selectedStoreId && selectedLedgerPeriod
    ? ledgers.find((ledger) => ledger.store_id === selectedStoreId && ledger.period === selectedLedgerPeriod)
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
  const matchModalVisibleRecords = unmatchedRecords
    .filter((record) => {
      if (matchChannelNames.length && !matchChannelNames.includes(record.channel)) return false;
      const [startDate, endDate] = matchDateRange;
      if (!startDate || !endDate) return false;
      const value = dayjs(record.revenue_date);
      return (
        (value.isAfter(startDate, "day") || value.isSame(startDate, "day")) &&
        (value.isBefore(endDate, "day") || value.isSame(endDate, "day"))
      );
    })
    .sort((left, right) => left.revenue_date.localeCompare(right.revenue_date));
  const matchModalSelectedIdSet = new Set(matchModalSelectedRecordIds);
  const matchModalSelectedRecords = matchModalVisibleRecords.filter((record) => matchModalSelectedIdSet.has(record.id));
  const matchModalGrossAmount = matchModalSelectedRecords.reduce((sum, record) => sum + moneyValue(record.gross_amount), 0);
  const matchModalNetAmount = matchModalSelectedRecords.reduce((sum, record) => sum + moneyValue(record.net_amount), 0);
  const matchModalFeeAmount = matchModalSelectedRecords.reduce((sum, record) => sum + moneyValue(record.fee_amount), 0);
  const matchModalDifference = bankRemaining - matchModalNetAmount;
  const matchModalVisibleRecordIds = matchModalVisibleRecords.map((record) => record.id).join("|");
  const isMatchDateRangeComplete = Boolean(matchDateRange[0] && matchDateRange[1]);
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
  const activeChannelOptions = channels
    .filter((channel) => channel.status === "active")
    .map((channel) => ({ label: channel.name, value: channel.name }));
  const unmatchedChannelNames = useMemo(
    () => Array.from(new Set(unmatchedRecords.map((record) => record.channel))).sort(),
    [unmatchedRecords],
  );
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
      setIsMatchModalOpen(false);
      setMatchChannelNames([]);
      setMatchDateRange([null, null]);
      setMatchModalSelectedRecordIds([]);
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
  }, [selectedStoreId, selectedLedgerPeriod]);

  function openMatchModal(transaction: BankTransaction) {
    const remaining = remainingAmount(transaction);
    if (remaining <= 0) return;
    setSelectedTransaction(transaction);
    setSelectedRecordIds([]);
    setMatchValidationMessage(null);
    const defaultChannels = channelFilter
      ? [channelFilter]
      : initialChannel
        ? [initialChannel]
        : [unmatchedChannelNames[0] ?? channels.find((channel) => channel.status === "active")?.name ?? channels[0]?.name].filter(Boolean) as string[];
    setMatchChannelNames(defaultChannels);
    setMatchDateRange([null, null]);
    setMatchModalSelectedRecordIds([]);
    setIsMatchModalOpen(true);
  }

  function applyMatchModalSelection() {
    if (!selectedTransaction) {
      setMatchValidationMessage("请先选择收入银行流水。");
      return null;
    }
    const [startDate, endDate] = matchDateRange;
    if (!startDate || !endDate) {
      setMatchValidationMessage("请选择收入日期范围。");
      return null;
    }
    if (!matchChannelNames.length) {
      setMatchValidationMessage("请选择收入渠道。");
      return null;
    }
    const selectedIds = matchModalSelectedRecordIds.filter((recordId) =>
      matchModalVisibleRecords.some((record) => record.id === recordId),
    );
    if (!selectedIds.length) {
      setMatchValidationMessage("请选择要匹配的营业收入。");
      return null;
    }
    const selectedRecordsInModal = matchModalVisibleRecords.filter((record) => selectedIds.includes(record.id));
    if (!selectedRecordsInModal.length) {
      setMatchValidationMessage("该渠道和日期范围内没有可匹配营业收入。");
      return null;
    }
    setChannelFilter(matchChannelNames.length === 1 ? matchChannelNames[0] : undefined);
    setRevenueDateRange(matchDateRange);
    setSelectedRecordIds(selectedIds);
    setMatchValidationMessage(null);
    return {
      amount: selectedRecordsInModal.reduce((sum, record) => sum + moneyValue(record.net_amount), 0),
      selectedNetAmount: selectedRecordsInModal.reduce((sum, record) => sum + moneyValue(record.net_amount), 0),
      revenueRecordIds: selectedIds,
      recordCount: selectedIds.length,
    };
  }

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
    const selected = matchModalVisibleRecords
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

  useEffect(() => {
    if (!isMatchModalOpen || !isMatchDateRangeComplete) {
      setMatchModalSelectedRecordIds([]);
      return;
    }
    setMatchModalSelectedRecordIds(matchModalVisibleRecords.map((record) => record.id));
  }, [isMatchModalOpen, isMatchDateRangeComplete, matchModalVisibleRecordIds]);

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
    setMatchValidationMessage(null);
    return {
      startDate,
      endDate,
      amount: selectedAmount,
      revenueRecordIds: selectedRecords.map((record) => record.id),
    };
  }

  async function saveMatch(selection: { amount: number; revenueRecordIds: string[]; recordCount: number }) {
    const storeId = selectedStoreId ?? initialStoreId;
    if (!storeId) {
      setMatchValidationMessage("请先选择门店。");
      return false;
    }
    if (!selectedTransaction) {
      setMatchValidationMessage("请先选择左侧收入银行流水。");
      return false;
    }
    setIsSaving(true);
    setSubmitStatus("正在提交收入匹配");
    message.loading({ content: "正在提交收入匹配", key: "revenue-match-submit", duration: 0 });
    try {
      await apiClient.matches.createRevenueBatch({
        bank_transaction_id: selectedTransaction.id,
        amount: selection.amount.toFixed(2),
        accounting_period: initialLedgerPeriod ?? selectedTransaction.ledger_period ?? selectedLedgerPeriod,
        revenue_record_ids: selection.revenueRecordIds,
        confidence: "100.00",
        reason: "营业收入记录手动关联银行流水",
      });
      setSubmitStatus(`已选中 ${selection.revenueRecordIds.length} 条营业收入，正在刷新`);
      await loadStoreWorkspace(storeId, selectedTransaction.id);
      setSubmitStatus(`收入对账已确认，已关联 ${selection.recordCount} 条营业收入`);
      message.success({ content: `已确认匹配 ${selection.recordCount} 条营业收入`, key: "revenue-match-submit" });
      setIsMatchModalOpen(false);
      return true;
    } catch (error) {
      setSubmitStatus(null);
      message.destroy("revenue-match-submit");
      message.error(error instanceof Error ? error.message : "确认收入对账失败");
      setErrorMessage(error instanceof Error ? error.message : "确认收入对账失败");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function confirmMatch() {
    const selection = validateSelection();
    if (!selection) return;
    await saveMatch({ ...selection, recordCount: selection.revenueRecordIds.length });
  }

  async function confirmMatchModal() {
    const selection = applyMatchModalSelection();
    if (!selection) return;
    const difference = selection.amount - selection.selectedNetAmount;
    if (Math.abs(difference) > 0.005) {
      Modal.confirm({
        title: "实收金额与银行流水不一致",
        content: `银行流水剩余 ${formatMoney(selection.amount.toFixed(2))}，选择收入实收 ${formatMoney(selection.selectedNetAmount.toFixed(2))}，差额 ${formatMoney(difference.toFixed(2))}。是否仍然保存匹配？`,
        okText: "仍然保存",
        cancelText: "返回检查",
        onOk: () => saveMatch(selection),
      });
      return;
    }
    await saveMatch(selection);
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
    <AppShell title={currentStore?.name ? `${currentStore.name} · 收入对账` : "收入对账"} kicker={`账期：${selectedLedgerPeriod}`}>
      {initialStoreId ? (
        <StoreLedgerWorkspaceNav
          storeId={selectedStoreId ?? initialStoreId}
          storeName={currentStore?.name}
          period={selectedLedgerPeriod}
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
                          onClick={() => openMatchModal(transaction)}
                        >
                          <span className="bank-transaction-card__main">
                            <span className="bank-transaction-card__meta">
                              <Typography.Text strong>{dayjs(transaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
                              <Tag color="default" style={{ color: "#333", backgroundColor: "#f0f0f0" }}>💰 收入</Tag>
                              {transaction.ledger_period ? <Tag color="default" style={{ color: "#666", backgroundColor: "#f5f5f5" }}>{transaction.ledger_period}</Tag> : null}
                              {isFullyMatched ? <Tag color="success">✓ 已匹配</Tag> : <Tag color="warning">⧗ 待匹配</Tag>}
                            </span>
                            {transaction.counterparty_name && (
                              <Typography.Text className="bank-transaction-card__counterparty" style={{ fontSize: 13, color: "#1890ff", marginTop: 4 }}>
                                对方户名：{transaction.counterparty_name}
                              </Typography.Text>
                            )}
                            <Typography.Text className="bank-transaction-card__summary" ellipsis title={transaction.summary || "无摘要"}>
                              {transaction.summary ? `摘要：${transaction.summary}` : "无摘要"}
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

      <Modal
        title="收入流水匹配"
        open={isMatchModalOpen}
        onCancel={() => setIsMatchModalOpen(false)}
        onOk={() => void confirmMatchModal()}
        okText="确认匹配"
        confirmLoading={isSaving}
        width={820}
        destroyOnClose
      >
        <div className="revenue-match-modal">
          {selectedTransaction ? (
            <div className="revenue-match-modal__bank">
              <div>
                <Typography.Text type="secondary">银行流水</Typography.Text>
                <div className="revenue-match-modal__bank-title">
                  <Typography.Text strong>{dayjs(selectedTransaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
                  <Typography.Text ellipsis>{selectedTransaction.summary || selectedTransaction.counterparty_name || "无摘要"}</Typography.Text>
                </div>
              </div>
              <div className="revenue-match-modal__bank-amount">
                <Typography.Text className="income-amount">{formatMoney(selectedTransaction.amount)}</Typography.Text>
                <Typography.Text type="secondary">剩余 {formatMoney(bankRemaining.toFixed(2))}</Typography.Text>
              </div>
            </div>
          ) : null}

          <div className="revenue-match-modal__controls">
            <div className="revenue-match-modal__field">
              <Typography.Text type="secondary">收入渠道</Typography.Text>
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="选择渠道"
                value={matchChannelNames}
                options={activeChannelOptions}
                onChange={(value) => {
                  setMatchChannelNames(value);
                  setMatchValidationMessage(null);
                }}
                style={{ width: "100%" }}
              />
            </div>
            <div className="revenue-match-modal__field">
              <Typography.Text type="secondary">收入日期范围</Typography.Text>
              <DatePicker.RangePicker
                value={matchDateRange}
                onChange={(dates) => {
                  setMatchDateRange(normalizeDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null));
                  setMatchValidationMessage(null);
                }}
                onCalendarChange={(dates) => {
                  const nextRange = normalizeDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null);
                  if (!isCompleteDateRange(nextRange)) return;
                  setMatchDateRange(nextRange);
                  setMatchValidationMessage(null);
                }}
                style={{ width: "100%" }}
              />
            </div>
          </div>

          <Alert
            className="revenue-match-modal__hint"
            type={isMatchDateRangeComplete && matchChannelNames.length ? "info" : "warning"}
            showIcon
            message={
              isMatchDateRangeComplete && matchChannelNames.length
                ? `${matchChannelNames.join("、")} / ${matchDateRange[0]?.format("YYYY-MM-DD")} 至 ${matchDateRange[1]?.format("YYYY-MM-DD")} 的收入汇总`
                : "请选择收入渠道和完整日期范围，金额会自动汇总"
            }
          />

          {isMatchDateRangeComplete ? (
            <div className="revenue-match-modal__range-bar">
              <Typography.Text type="secondary">已选范围</Typography.Text>
              <Typography.Text strong>
                {matchDateRange[0]?.format("YYYY-MM-DD")} 至 {matchDateRange[1]?.format("YYYY-MM-DD")}
              </Typography.Text>
              <Typography.Text type="secondary">共 {matchModalVisibleRecords.length} 条收入记录</Typography.Text>
            </div>
          ) : null}

          <div className="revenue-match-summary revenue-match-summary--modal">
            <Statistic title="收入条数" value={matchModalSelectedRecords.length} />
            <Statistic title="经营收入" value={formatMoney(matchModalGrossAmount.toFixed(2))} />
            <Statistic title="实收金额" value={formatMoney(matchModalNetAmount.toFixed(2))} valueStyle={{ color: "#1890ff" }} />
            <Statistic title="手续费" value={formatMoney(matchModalFeeAmount.toFixed(2))} />
            <Statistic
              title="差额"
              value={formatMoney(matchModalDifference.toFixed(2))}
              valueStyle={{ color: Math.abs(matchModalDifference) <= 0.005 ? "#52c41a" : "#ff4d4f" }}
            />
          </div>

          {Math.abs(matchModalDifference) > 0.005 && matchModalSelectedRecords.length ? (
            <Alert
              type="warning"
              showIcon
              message="实收金额与银行流水不一致"
              description="保存时会再次提醒，确认后仍允许保存匹配。"
            />
          ) : null}
          {matchValidationMessage ? <Alert type="warning" showIcon message={matchValidationMessage} /> : null}

          <Table
            className="revenue-match-modal__table"
            rowKey="id"
            size="small"
            columns={[
              { title: "日期", dataIndex: "revenue_date", width: 110 },
              { title: "渠道", dataIndex: "channel", width: 130 },
              { title: "经营收入", dataIndex: "gross_amount", width: 120, align: "right", render: (value: string) => formatMoney(value) },
              { title: "实收金额", dataIndex: "net_amount", width: 120, align: "right", render: (value: string) => formatMoney(value) },
              { title: "手续费", dataIndex: "fee_amount", width: 110, align: "right", render: (value: string) => formatMoney(value) },
              { title: "备注", dataIndex: "remark", ellipsis: true, render: (value?: string | null) => value || "-" },
            ]}
            dataSource={matchModalVisibleRecords}
            rowSelection={{
              selectedRowKeys: matchModalSelectedRecordIds,
              onChange: (selectedRowKeys) => setMatchModalSelectedRecordIds(selectedRowKeys as string[]),
            }}
            pagination={{ pageSize: 6, size: "small" }}
          />
        </div>
      </Modal>
    </AppShell>
  );
}
