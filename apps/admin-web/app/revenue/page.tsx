"use client";

import { Button, Card, Form, Input, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import customParseFormat from "dayjs/plugin/customParseFormat";
import dayjs from "dayjs";
import { EditOutlined, PlusOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Ledger, RevenueBankMatch, RevenueChannel, RevenueRecord, Store } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { MoneyDisplay } from "../components/MoneyDisplay";
import { StoreLedgerWorkspaceNav } from "../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../lib/api";
import { getLedgers, getStores } from "../lib/referenceData";
import { useClientSearchParams } from "../lib/searchParams";

dayjs.extend(customParseFormat);

interface RevenueFilterValues {
  store_id?: string;
  ledger_period?: string;
  channel?: string;
}

type RevenueEntryField = "revenue_date" | "gross_amount" | "net_amount" | "remark";

interface RevenueEntryRow {
  key: string;
  id?: string;
  revenue_date: string;
  gross_amount: string;
  net_amount: string;
  remark: string;
  matchStatus: "unmatched" | "pending" | "matched";
}

const revenueEntryFields: RevenueEntryField[] = ["revenue_date", "gross_amount", "net_amount", "remark"];
const revenueEntryHeaders: Record<RevenueEntryField, string> = {
  revenue_date: "日期",
  gross_amount: "经营收入",
  net_amount: "实收金额",
  remark: "备注",
};

function createRevenueEntryRows(period: string, filledWithZero = false): RevenueEntryRow[] {
  const month = dayjs(`${period}-01`);
  const days = month.isValid() ? month.daysInMonth() : dayjs().daysInMonth();
  const base = month.isValid() ? month : dayjs().startOf("month");
  return Array.from({ length: days }, (_, index): RevenueEntryRow => ({
    key: `revenue-entry-${base.format("YYYY-MM")}-${index + 1}`,
    revenue_date: base.date(index + 1).format("YYYY-MM-DD"),
    gross_amount: filledWithZero ? "0" : "",
    net_amount: filledWithZero ? "0" : "",
    remark: "",
    matchStatus: "unmatched",
  }));
}

function isRevenueEntryRowEmpty(row: RevenueEntryRow) {
  return !row.gross_amount.trim() && !row.net_amount.trim();
}

function normalizeFullWidthText(value: string) {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, " ");
}

function normalizePastedCell(value?: string | null) {
  if (!value) return "";
  let text = normalizeFullWidthText(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (text.length >= 3 && text.startsWith("=\"") && text.endsWith("\"")) {
    text = text.slice(2, -1).replace(/""/g, "\"").trim();
  }
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    text = text.slice(1, -1).replace(/""/g, "\"").trim();
  }
  return text;
}

function normalizePastedAmount(value?: string | null) {
  const text = normalizePastedCell(value)
    .replace(/[￥¥,\s]/g, "")
    .replace(/[()（）]/g, (char) => (char === "(" || char === "（" ? "-" : ""))
    .replace(/[^\d.+-]/g, "");
  const normalized = text.replace(/(?!^)-/g, "").replace(/(?!^)\+/g, "");
  return normalized && normalized !== "-" && normalized !== "." ? normalized : "";
}

function parseRevenueEntryRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const delimiter = source.includes("\t") ? "\t" : ",";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];
    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      row.push(normalizePastedCell(cell));
      cell = "";
      continue;
    }
    if (!inQuotes && char === "\n") {
      row.push(normalizePastedCell(cell));
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(normalizePastedCell(cell));
  if (row.some((item) => item.trim())) rows.push(row);
  if (!rows.length) return [];
  const headerWords = Object.values(revenueEntryHeaders).concat(["收入日期", "收入", "金额", "营业额", "流水", "手续费"]);
  const firstCells = rows[0].map((cell) => normalizePastedCell(cell));
  const hasHeader = firstCells.some((cell) => headerWords.includes(cell));
  return hasHeader ? rows.slice(1) : rows;
}

function parseEntryDate(value: string) {
  const text = normalizePastedCell(value);
  if (!text) return null;
  const formats = ["YYYY-MM-DD", "YYYY/MM/DD", "YYYY年MM月DD日", "YYYY-MM-DD HH:mm:ss", "YYYY/MM/DD HH:mm:ss"];
  const parsed = dayjs(text, formats, true);
  if (parsed.isValid()) return parsed;
  const fallback = dayjs(text);
  return fallback.isValid() ? fallback : null;
}

function revenueMatchStatusText(status: RevenueEntryRow["matchStatus"]) {
  if (status === "matched") return "已匹配";
  if (status === "pending") return "匹配中";
  return "未匹配";
}

function revenueMatchStatusColor(status: RevenueEntryRow["matchStatus"]) {
  if (status === "matched") return "success";
  if (status === "pending") return "processing";
  return "default";
}

function isActiveRevenueMatch(match: RevenueBankMatch) {
  return match.status !== "rejected";
}

function isRevenueRecordMatched(record: RevenueRecord, matches: RevenueBankMatch[]) {
  return matches.some(
    (match) =>
      isActiveRevenueMatch(match) &&
      (match.revenue_record_ids?.includes(record.id) ||
        (!match.revenue_record_ids?.length &&
          match.channel === record.channel &&
          match.revenue_start_date <= record.revenue_date &&
          match.revenue_end_date >= record.revenue_date)),
  );
}

function defaultLedgerPeriod() {
  return dayjs().subtract(1, "month").format("YYYY-MM");
}

export default function RevenuePage() {
  const searchParams = useClientSearchParams();
  const queryStoreId = searchParams.get("store_id") ?? undefined;
  const queryLedgerPeriod = searchParams.get("ledger_period") ?? undefined;
  const queryChannel = searchParams.get("channel") ?? undefined;
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [channels, setChannels] = useState<RevenueChannel[]>([]);
  const [records, setRecords] = useState<RevenueRecord[]>([]);
  const [revenueMatches, setRevenueMatches] = useState<RevenueBankMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState<string | undefined>(queryChannel);
  const [isEditing, setIsEditing] = useState(false);
  const [batchEditRows, setBatchEditRows] = useState<RevenueEntryRow[]>([]);
  const [focusedEntryCell, setFocusedEntryCell] = useState<{ rowIndex: number; field: RevenueEntryField }>({ rowIndex: 0, field: "gross_amount" });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterForm] = Form.useForm<RevenueFilterValues>();
  const watchedLedgerPeriod = Form.useWatch("ledger_period", filterForm);
  const loadRequestIdRef = useRef(0);
  const entryChannelRef = useRef<string | null>(null);

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const ledgersByKey = useMemo(
    () => new Map(ledgers.map((ledger) => [`${ledger.store_id}|${ledger.period}`, ledger])),
    [ledgers],
  );
  const fallbackLedgerPeriod = useMemo(() => defaultLedgerPeriod(), []);
  const activeLedgerPeriod = queryLedgerPeriod ?? watchedLedgerPeriod ?? fallbackLedgerPeriod;
  const activeLedger = queryStoreId ? ledgersByKey.get(`${queryStoreId}|${activeLedgerPeriod}`) : undefined;
  const revenueChannelsHref = useMemo(() => {
    const returnParams = new URLSearchParams();
    if (queryStoreId) returnParams.set("store_id", queryStoreId);
    if (activeLedgerPeriod) returnParams.set("ledger_period", activeLedgerPeriod);
    const returnTo = `/revenue${returnParams.toString() ? `?${returnParams.toString()}` : ""}`;
    return `/revenue-channels?return_to=${encodeURIComponent(returnTo)}`;
  }, [activeLedgerPeriod, queryStoreId]);
  const ledgerPeriodOptions = useMemo(() => {
    const periods = new Set(ledgers.map((ledger) => ledger.period));
    if (activeLedgerPeriod) periods.add(activeLedgerPeriod);
    return Array.from(periods)
      .sort()
      .reverse()
      .map((period) => ({ label: period, value: period }));
  }, [activeLedgerPeriod, ledgers]);
  const currentStore = queryStoreId ? storesById.get(queryStoreId) : undefined;
  const channelSummaries = useMemo(() => {
    type Summary = {
      key: string;
      channel: RevenueChannel | null;
      name: string;
      grossAmount: number;
      netAmount: number;
      feeAmount: number;
      recordCount: number;
      dayCount: number;
    };

    const summaryMap = new Map<string, Summary>();
    function ensureSummary(name: string) {
      let summary = summaryMap.get(name);
      if (!summary) {
        summary = {
          key: name,
          channel: null,
          name,
          grossAmount: 0,
          netAmount: 0,
          feeAmount: 0,
          recordCount: 0,
          dayCount: 0,
        };
        summaryMap.set(name, summary);
      }
      return summary;
    }

    channels.forEach((channel) => {
      ensureSummary(channel.name).channel = channel;
    });
    records.forEach((record) => {
      const summary = summaryMap.get(record.channel);
      if (!summary) return;
      summary.grossAmount += Number(record.gross_amount || 0);
      summary.netAmount += Number(record.net_amount || 0);
      summary.feeAmount += Number(record.fee_amount || 0);
      summary.recordCount += 1;
      summary.dayCount += 1;
    });

    const dayCountMap = new Map<string, Set<string>>();
    records.forEach((record) => {
      const days = dayCountMap.get(record.channel) ?? new Set<string>();
      days.add(record.revenue_date);
      dayCountMap.set(record.channel, days);
    });

    return Array.from(summaryMap.values())
      .map((summary) => ({
        ...summary,
        dayCount: dayCountMap.get(summary.name)?.size ?? summary.dayCount,
      }))
      .sort((left, right) => {
        const leftSort = left.channel?.sort_order ?? Number.MAX_SAFE_INTEGER;
        const rightSort = right.channel?.sort_order ?? Number.MAX_SAFE_INTEGER;
        return leftSort - rightSort || left.name.localeCompare(right.name);
      });
  }, [channels, records]);
  const batchEditColumns = useMemo(() => buildEntryColumns(batchEditRows, setBatchEditRows, isEditing), [batchEditRows, focusedEntryCell, isEditing]);

  function calculateFee(grossAmount?: string | number | null, netAmount?: string | number | null) {
    const gross = Number(grossAmount ?? 0);
    const net = Number(netAmount ?? 0);
    if (!Number.isFinite(gross) || !Number.isFinite(net)) return "0.00";
    return Math.max(gross - net, 0).toFixed(2);
  }

  function calculateFeeRate(grossAmount?: string | number | null, feeAmount?: string | number | null) {
    const gross = Number(grossAmount ?? 0);
    const fee = Number(feeAmount ?? 0);
    if (!Number.isFinite(gross) || gross <= 0 || !Number.isFinite(fee)) return "0.00%";
    return `${((fee / gross) * 100).toFixed(2)}%`;
  }

  function buildFilterParams(values?: RevenueFilterValues, channel?: string) {
    const params = new URLSearchParams({ page_size: "500" });
    const storeId = values?.store_id ?? queryStoreId;
    const ledgerPeriod = values?.ledger_period ?? queryLedgerPeriod ?? fallbackLedgerPeriod;
    const revenueChannel = channel ?? values?.channel ?? selectedChannel;
    if (storeId) params.set("store_id", storeId);
    if (ledgerPeriod) params.set("ledger_period", ledgerPeriod);
    if (revenueChannel) params.set("channel", revenueChannel);
    return `?${params.toString()}`;
  }

  function getActiveFilters(): RevenueFilterValues {
    const formValues = filterForm.getFieldsValue();
    return {
      store_id: queryStoreId ?? formValues.store_id,
      ledger_period: queryLedgerPeriod ?? formValues.ledger_period ?? fallbackLedgerPeriod,
    };
  }

  function buildRowsFromRecords(
    baseRows: RevenueEntryRow[],
    channelRecords: RevenueRecord[],
    channelMatches: RevenueBankMatch[],
  ) {
    const recordByDate = new Map(channelRecords.map((record) => [record.revenue_date, record]));
    const matchStatusByRecordId = new Map<string, RevenueEntryRow["matchStatus"]>();
    channelRecords.forEach((record) => {
      const recordMatches = channelMatches.filter((match) =>
        isActiveRevenueMatch(match) &&
        (match.revenue_record_ids?.includes(record.id) ||
          (!match.revenue_record_ids?.length &&
            match.channel === record.channel &&
            match.revenue_start_date <= record.revenue_date &&
            match.revenue_end_date >= record.revenue_date)),
      );
      if (recordMatches.some((match) => match.status === "confirmed")) {
        matchStatusByRecordId.set(record.id, "matched");
      } else if (recordMatches.length) {
        matchStatusByRecordId.set(record.id, "pending");
      }
    });
    return baseRows.map((row) => {
      const record = recordByDate.get(row.revenue_date);
      return record
        ? {
            key: record.id,
            id: record.id,
            revenue_date: record.revenue_date,
            gross_amount: String(record.gross_amount),
            net_amount: String(record.net_amount),
            remark: record.remark ?? "",
            matchStatus: matchStatusByRecordId.get(record.id) ?? (isRevenueRecordMatched(record, channelMatches) ? "matched" : "unmatched"),
          } satisfies RevenueEntryRow
        : row;
    });
  }

  useEffect(() => {
    void (async () => {
      const [storesRes, ledgersRes, channelsRes] = await Promise.all([
        getStores(),
        getLedgers(),
        apiClient.revenueChannels.list("?page_size=500"),
      ]);
      setStores(storesRes);
      setLedgers(ledgersRes);
      setChannels(channelsRes.items);
    })();
  }, []);

  useEffect(() => {
    setSelectedChannel(queryChannel);
  }, [queryChannel]);

  useEffect(() => {
    if (entryChannelRef.current === selectedChannel) return;
    setIsEditing(false);
  }, [selectedChannel]);

  useEffect(() => {
    if (selectedChannel || !channels.length) return;
    const defaultChannel = channels.find((channel) => channel.status === "active") ?? channels[0];
    if (defaultChannel) setSelectedChannel(defaultChannel.name);
  }, [channels, selectedChannel]);

  useEffect(() => {
    if (!selectedChannel) return;
    void loadRecords(getActiveFilters(), selectedChannel);
  }, [selectedChannel, queryStoreId, queryLedgerPeriod]);

  async function loadRecords(filters: RevenueFilterValues, channel?: string) {
    const requestId = ++loadRequestIdRef.current;
    setIsLoading(true);
    setErrorMessage(null);
    const period = filters.ledger_period ?? queryLedgerPeriod ?? fallbackLedgerPeriod;
    filterForm.setFieldsValue({
      store_id: filters.store_id,
      ledger_period: period,
    });
    try {
      const [recordsRes, revenueMatchesRes] = await Promise.all([
        apiClient.revenueRecords.list(buildFilterParams(filters, channel)),
        apiClient.matches.listRevenue(
          (() => {
            const params = new URLSearchParams({ page_size: "500" });
            const storeId = filters.store_id ?? queryStoreId;
            const revenueChannel = channel ?? filters.channel ?? selectedChannel;
            if (storeId) params.set("store_id", storeId);
            if (revenueChannel) params.set("channel", revenueChannel);
            return `?${params.toString()}`;
          })(),
        ),
      ]);
      if (requestId === loadRequestIdRef.current) {
        setRecords(recordsRes.items);
        setRevenueMatches(revenueMatchesRes.items);
        if (channel) {
          setBatchEditRows(buildRowsFromRecords(createRevenueEntryRows(period, false), recordsRes.items, revenueMatchesRes.items));
          setIsEditing(entryChannelRef.current === channel);
          if (entryChannelRef.current === channel) entryChannelRef.current = null;
        } else {
          setBatchEditRows([]);
        }
      }
    } catch (error) {
      if (requestId === loadRequestIdRef.current) {
        setErrorMessage(error instanceof Error ? error.message : "加载失败");
      }
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }

  async function submitBatchEdit() {
    const filterValues = filterForm.getFieldsValue();
    const storeId = queryStoreId ?? filterValues.store_id;
    const period = queryLedgerPeriod ?? filterValues.ledger_period ?? fallbackLedgerPeriod;
    const channel = selectedChannel;
    if (!storeId || !period || !channel) {
      message.warning("请填写门店、账期和收入渠道");
      return;
    }
    const nonEmptyRows = batchEditRows.filter((row) => !isRevenueEntryRowEmpty(row));
    setIsLoading(true);
    try {
      let updatedCount = 0;
      let createdCount = 0;
      let deletedCount = 0;
      const failedRows: string[] = [];
      const existingRecordsByDate = new Map(records.map((record) => [record.revenue_date, record]));

      for (const row of nonEmptyRows) {
        const existingRecord = existingRecordsByDate.get(row.revenue_date);
        const grossAmount = normalizePastedAmount(row.gross_amount);
        const netAmount = normalizePastedAmount(row.net_amount) || grossAmount;
        if (!grossAmount && !netAmount) continue;
        const payload = {
          store_id: storeId,
          ledger_period: period,
          revenue_date: row.revenue_date,
          channel,
          gross_amount: grossAmount || "0",
          net_amount: netAmount || "0",
          fee_amount: calculateFee(grossAmount, netAmount || grossAmount),
          remark: normalizePastedCell(row.remark) || null,
        };
        try {
          if (existingRecord) {
            await apiClient.revenueRecords.update(existingRecord.id, payload);
            updatedCount += 1;
          } else {
            await apiClient.revenueRecords.create(payload);
            createdCount += 1;
          }
        } catch (error) {
          failedRows.push(`${row.revenue_date}：${error instanceof Error ? error.message : "保存失败"}`);
        }
      }
      for (const record of records) {
        const row = batchEditRows.find((item) => item.revenue_date === record.revenue_date);
        if (!row || !isRevenueEntryRowEmpty(row)) continue;
        try {
          await apiClient.revenueRecords.delete(record.id);
          deletedCount += 1;
        } catch (error) {
          failedRows.push(`${record.revenue_date}：${error instanceof Error ? error.message : "删除失败"}`);
        }
      }
      if (updatedCount || createdCount || deletedCount) {
        message.success(`批量编辑完成，更新 ${updatedCount} 条，新增 ${createdCount} 条，删除 ${deletedCount} 条`);
      }
      if (failedRows.length) {
        setErrorMessage(`部分收入未保存：${failedRows.slice(0, 5).join("；")}`);
        await loadRecords(getActiveFilters(), selectedChannel);
        return;
      }
      await loadRecords(getActiveFilters(), selectedChannel);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "批量编辑失败");
    } finally {
      setIsLoading(false);
    }
  }

  function resetBatchEditRows() {
    const period = queryLedgerPeriod ?? filterForm.getFieldValue("ledger_period") ?? fallbackLedgerPeriod;
    setBatchEditRows(buildRowsFromRecords(createRevenueEntryRows(period, false), records, revenueMatches));
  }

  function clearBatchEditRows() {
    const period = queryLedgerPeriod ?? filterForm.getFieldValue("ledger_period") ?? fallbackLedgerPeriod;
    setBatchEditRows(createRevenueEntryRows(period, false));
    setIsEditing(true);
  }

  function startChannelEntry(channelName: string) {
    entryChannelRef.current = channelName;
    setSelectedChannel(channelName);
    if (selectedChannel === channelName) {
      entryChannelRef.current = null;
      setIsEditing(true);
    }
  }

  function buildEntryColumns(
    rows: RevenueEntryRow[],
    setRows: (rows: RevenueEntryRow[]) => void,
    editing: boolean,
  ): ColumnsType<RevenueEntryRow> {
    const editableColumns: ColumnsType<RevenueEntryRow> = revenueEntryFields.map((field) => ({
      title: revenueEntryHeaders[field],
      dataIndex: field,
      width: field === "revenue_date" ? 104 : field === "remark" ? 160 : 110,
      render: (value: string, record, index: number) => {
        if (!editing) {
          if (field === "revenue_date") return <Typography.Text>{value}</Typography.Text>;
          if (field === "remark") return <Typography.Text type={value ? undefined : "secondary"}>{value || "-"}</Typography.Text>;
          return <MoneyDisplay value={Number(value || 0)} />;
        }
        return (
          <Input
            value={value}
            size="small"
            variant="borderless"
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (!text.includes("\t") && !text.includes("\n")) {
                if (field !== "gross_amount" && field !== "net_amount") return;
                const amount = normalizePastedAmount(text);
                if (!amount || amount === text.trim()) return;
                event.preventDefault();
                const updated = [...rows];
                updated[index][field] = amount;
                setRows(updated);
                message.success("已清理金额格式");
                return;
              }
              if (!text.includes("\t") && !text.includes("\n")) return;
              event.preventDefault();
              const parsedRows = parseRevenueEntryRows(text);
              if (!parsedRows.length) return;
              const updatedRows = [...rows];
              const startFieldIndex = revenueEntryFields.indexOf(field);
              parsedRows.forEach((cells, rowOffset) => {
                const rowIndex = index + rowOffset;
                if (rowIndex >= updatedRows.length) return;
                cells.forEach((cell, cellOffset) => {
                  const targetField = revenueEntryFields[startFieldIndex + cellOffset];
                  if (!targetField) return;
                  const valueText = normalizePastedCell(cell);
                  if (!valueText) return;
                  const nextValue =
                    targetField === "revenue_date"
                      ? parseEntryDate(valueText)?.format("YYYY-MM-DD") ?? valueText
                      : targetField === "gross_amount" || targetField === "net_amount"
                        ? normalizePastedAmount(valueText)
                        : valueText;
                  if (!nextValue) return;
                  updatedRows[rowIndex] = {
                    ...updatedRows[rowIndex],
                    [targetField]: nextValue,
                  };
                });
              });
              setRows(updatedRows);
              message.success("已粘贴收入数据");
            }}
            onChange={(event) => {
              const updated = [...rows];
              updated[index][field] =
                field === "gross_amount" || field === "net_amount"
                  ? normalizePastedAmount(event.target.value)
                  : event.target.value;
              setRows(updated);
            }}
            onFocus={() => setFocusedEntryCell({ rowIndex: index, field })}
            style={{
              border: focusedEntryCell.rowIndex === index && focusedEntryCell.field === field ? "1px solid var(--primary-500)" : undefined,
              height: 28,
              paddingInline: 8,
            }}
          />
        );
      },
    }));

    return [
      ...editableColumns.slice(0, 3),
      {
        title: "匹配状态",
        key: "match_status",
        width: 92,
        render: (_, record) => <Tag color={revenueMatchStatusColor(record.matchStatus)}>{revenueMatchStatusText(record.matchStatus)}</Tag>,
      },
      {
        title: "手续费",
        key: "fee_amount",
        width: 96,
        align: "right",
        render: (_, record) =>
          isRevenueEntryRowEmpty(record) ? (
            <Typography.Text type="secondary">-</Typography.Text>
          ) : (
            <MoneyDisplay value={Number(calculateFee(record.gross_amount, record.net_amount || record.gross_amount))} />
          ),
      },
      {
        title: "费率",
        key: "fee_rate",
        width: 78,
        align: "right",
        render: (_, record) =>
          isRevenueEntryRowEmpty(record)
            ? <Typography.Text type="secondary">-</Typography.Text>
            : calculateFeeRate(record.gross_amount, calculateFee(record.gross_amount, record.net_amount || record.gross_amount)),
      },
      editableColumns[3],
    ];
  }

  return (
    <AppShell title={currentStore?.name ? `${currentStore.name} · 营业收入` : "营业收入"} kicker={`账期：${activeLedgerPeriod}`}>
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }} className="maintenance-page">
        {queryStoreId && (
          <StoreLedgerWorkspaceNav
            storeId={queryStoreId}
            storeName={currentStore?.name}
            period={activeLedgerPeriod}
            periodOptions={ledgerPeriodOptions}
            statusLabel={currentStore?.status === "active" ? "启用门店" : currentStore ? "停用门店" : undefined}
            ledgerStatusLabel={activeLedger?.status === "closed" ? "已封账" : activeLedger ? "进行中" : undefined}
            activeKey="revenue"
          />
        )}

        {errorMessage && (
          <Typography.Text type="danger">
            加载失败：{errorMessage}
          </Typography.Text>
        )}

        <div className="revenue-channel-section">
          <div className="revenue-channel-section__header">
            <Typography.Title level={5} style={{ margin: 0 }}>
              收入渠道
            </Typography.Title>
            <Button icon={<PlusOutlined />} href={revenueChannelsHref}>
              添加渠道
            </Button>
          </div>
          <div className="revenue-channel-grid">
            {channelSummaries.map((summary) => {
              const channel = summary.channel;
              const isInactive = channel?.status === "inactive";
              const isSelected = selectedChannel === summary.name;
              return (
                <Card
                  key={summary.key}
                  size="small"
                  className={`revenue-channel-card${isInactive ? " revenue-channel-card--inactive" : ""}${isSelected ? " revenue-channel-card--selected" : ""}`}
                  hoverable
                  onClick={() => setSelectedChannel(summary.name)}
                  style={{ cursor: "pointer" }}
                >
                  <div className="revenue-channel-card__header">
                    <div className="revenue-channel-card__title-wrap">
                      <Typography.Text className="revenue-channel-card__title">{summary.name}</Typography.Text>
                      {isSelected && <Tag color="success">当前查看</Tag>}
                    </div>
                    <Button
                      size="small"
                      type={isSelected && isEditing ? "primary" : "default"}
                      icon={<PlusOutlined />}
                      className="revenue-channel-card__entry-button"
                      disabled={isInactive}
                      onClick={(event) => {
                        event.stopPropagation();
                        startChannelEntry(summary.name);
                      }}
                    >
                      录入
                    </Button>
                  </div>
                  <div className="revenue-channel-card__amount">
                    <MoneyDisplay value={summary.grossAmount} size="large" />
                  </div>
                </Card>
              );
            })}
          </div>
        </div>

        <Card
          title={selectedChannel ? `${selectedChannel} 收入明细` : "营业收入列表"}
          className="data-table-card maintenance-table-card"
          extra={
            selectedChannel ? (
              <Space>
                <Button
                  type={isEditing ? "default" : "primary"}
                  icon={isEditing ? undefined : <EditOutlined />}
                  className={isEditing ? undefined : "revenue-detail-edit-button"}
                  onClick={() => {
                    if (isEditing) {
                      setIsEditing(false);
                      resetBatchEditRows();
                      return;
                    }
                    setIsEditing(true);
                  }}
                >
                  {isEditing ? "取消" : "编辑"}
                </Button>
                {isEditing && (
                  <Button onClick={clearBatchEditRows}>
                    清空重录
                  </Button>
                )}
                {isEditing && (
                  <Button type="primary" onClick={() => void submitBatchEdit()} loading={isLoading}>
                    保存
                  </Button>
                )}
              </Space>
            ) : null
          }
        >
          {queryStoreId ? null : (
            <Form form={filterForm} layout="inline" onFinish={(values) => loadRecords(values, selectedChannel)} className="table-filter-form">
              <Form.Item name="store_id" label="门店">
                <Select allowClear className="filter-select" options={stores.map((store) => ({ label: store.name, value: store.id }))} />
              </Form.Item>
              <Form.Item name="ledger_period" label="账期">
                <Select allowClear className="filter-select" options={ledgerPeriodOptions} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={isLoading}>筛选</Button>
              </Form.Item>
            </Form>
          )}
          <Table<RevenueEntryRow>
            rowKey="key"
            columns={batchEditColumns}
            dataSource={batchEditRows}
            loading={isLoading}
            size="small"
            pagination={false}
            scroll={{ x: 980 }}
            className="revenue-entry-table"
            sticky
          />
        </Card>
      </Space>

    </AppShell>
  );
}
