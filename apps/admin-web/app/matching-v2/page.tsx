"use client";

import { Alert, Button, Space, message, Spin } from "antd";
import { useEffect, useState, useCallback, useMemo } from "react";
import type {
  BankTransaction,
  ExpenseBankMatch,
  ExpenseItem,
  Store,
} from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { TransactionList } from "../components/TransactionList";
import { MatchingPanel } from "../components/MatchingPanel";
import { apiClient } from "../lib/api";

interface MatchingData {
  stores: Store[];
  expenseItems: ExpenseItem[];
  bankTransactions: BankTransaction[];
  matches: ExpenseBankMatch[];
}

const emptyData: MatchingData = {
  stores: [],
  expenseItems: [],
  bankTransactions: [],
  matches: [],
};

interface MatchingSuggestion {
  expenseItem: ExpenseItem;
  matchedAmount: number;
  remainingAmount: number;
  confidence: number;
  reason: string;
}

export default function MatchingPageV2() {
  const [data, setData] = useState<MatchingData>(emptyData);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<BankTransaction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const storesMap = useMemo(() => new Map(data.stores.map((s) => [s.id, s])), [data.stores]);
  const expenseByIdMap = useMemo(() => new Map(data.expenseItems.map((e) => [e.id, e])), [data.expenseItems]);

  // 计算每个支出的已确认金额
  const confirmedExpenseAmountMap = useMemo(() => {
    const map = new Map<string, number>();
    data.matches
      .filter((m) => m.status === "confirmed")
      .forEach((m) => {
        const current = map.get(m.expense_item_id) || 0;
        map.set(m.expense_item_id, current + Number(m.amount || 0));
      });
    return map;
  }, [data.matches]);

  // 计算智能推荐
  const suggestions = useMemo((): MatchingSuggestion[] => {
    if (!selectedTransaction) return [];

    const transactionAmount = Number(selectedTransaction.amount);
    const remainingTransactionAmount =
      transactionAmount - Number(selectedTransaction.matched_amount || 0);

    // 筛选同门店、同账期的未付清支出
    const candidates = data.expenseItems
      .filter(
        (item) =>
          item.store_id === selectedTransaction.store_id &&
          item.ledger_period === selectedTransaction.ledger_period,
      )
      .map((item) => {
        const confirmedAmount = confirmedExpenseAmountMap.get(item.id) || 0;
        const remainingAmount = Number(item.amount) - confirmedAmount;

        if (remainingAmount <= 0) return null;

        // 计算匹配置信度
        let confidence = 0;
        let reasons: string[] = [];

        // 金额完全匹配
        const amountDiff = Math.abs(remainingAmount - remainingTransactionAmount);
        if (amountDiff < 0.01) {
          confidence += 50;
          reasons.push("金额完全匹配");
        } else if (amountDiff < remainingTransactionAmount * 0.05) {
          confidence += 30;
          reasons.push("金额接近");
        } else if (remainingAmount <= remainingTransactionAmount) {
          confidence += 20;
        }

        // 供应商名称匹配
        if (
          item.supplier_name &&
          selectedTransaction.counterparty_name &&
          (selectedTransaction.counterparty_name.includes(item.supplier_name) ||
            item.supplier_name.includes(selectedTransaction.counterparty_name))
        ) {
          confidence += 30;
          reasons.push("供应商名称匹配");
        }

        // 日期接近（7天内）
        if (item.expense_date) {
          const transactionDate = new Date(selectedTransaction.occurred_at);
          const expenseDate = new Date(item.expense_date);
          const daysDiff = Math.abs(
            (transactionDate.getTime() - expenseDate.getTime()) / (1000 * 60 * 60 * 24),
          );
          if (daysDiff <= 3) {
            confidence += 15;
            reasons.push("日期接近");
          } else if (daysDiff <= 7) {
            confidence += 10;
          }
        }

        // 摘要关键词匹配
        if (
          selectedTransaction.summary &&
          item.description &&
          (selectedTransaction.summary.includes(item.description) ||
            item.description.includes(selectedTransaction.summary))
        ) {
          confidence += 15;
          reasons.push("摘要匹配");
        }

        return {
          expenseItem: item,
          matchedAmount: confirmedAmount,
          remainingAmount,
          confidence: Math.min(confidence, 98),
          reason: reasons.join("、"),
        };
      })
      .filter((c): c is MatchingSuggestion => c !== null)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5); // 只显示前5个推荐

    return candidates;
  }, [selectedTransaction, data.expenseItems, confirmedExpenseAmountMap]);

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [stores, expenseItems, bankTransactions, matches] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.expenseItems.list("?page_size=500&payment_status=unpaid,partial_paid"),
        apiClient.bankTransactions.list("?page_size=500&direction=expense"),
        apiClient.matches.list("?page_size=500"),
      ]);

      setData({
        stores: stores.items,
        expenseItems: expenseItems.items,
        bankTransactions: bankTransactions.items,
        matches: matches.items,
      });
    } catch (error) {
      setData(emptyData);
      setErrorMessage(error instanceof Error ? error.message : "无法加载匹配数据");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  const handleSelectTransaction = useCallback((transaction: BankTransaction) => {
    setSelectedTransaction(transaction);
  }, []);

  const handleConfirm = useCallback(
    async (expenseItemId: string, amount: number) => {
      if (!selectedTransaction) return;

      setIsLoading(true);
      try {
        // 先创建候选匹配
        await apiClient.matches.create({
          expense_item_id: expenseItemId,
          bank_transaction_id: selectedTransaction.id,
          amount: amount.toFixed(2),
          confidence: String(suggestions.find((s) => s.expenseItem.id === expenseItemId)?.confidence || 0),
          reason: suggestions.find((s) => s.expenseItem.id === expenseItemId)?.reason || "",
        });

        // 立即确认
        const newMatches = await apiClient.matches.list("?page_size=500");
        const justCreated = newMatches.items.find(
          (m) =>
            m.expense_item_id === expenseItemId &&
            m.bank_transaction_id === selectedTransaction.id &&
            m.status === "candidate",
        );

        if (justCreated) {
          await apiClient.matches.confirm(justCreated.id, "admin");
        }

        message.success("匹配确认成功");

        // 重新加载数据
        await loadData();

        // 自动跳到下一条未匹配流水
        const nextUnmatched = data.bankTransactions.find(
          (t) =>
            t.id !== selectedTransaction.id &&
            Number(t.amount) - Number(t.matched_amount || 0) > 0,
        );

        if (nextUnmatched) {
          setSelectedTransaction(nextUnmatched);
        } else {
          setSelectedTransaction(null);
          message.success("🎉 所有流水已匹配完成！");
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : "确认匹配失败");
      } finally {
        setIsLoading(false);
      }
    },
    [selectedTransaction, suggestions, data.bankTransactions],
  );

  const handleReject = useCallback(
    async (expenseItemId: string) => {
      if (!selectedTransaction) return;

      setIsLoading(true);
      try {
        // 创建拒绝记录
        await apiClient.matches.create({
          expense_item_id: expenseItemId,
          bank_transaction_id: selectedTransaction.id,
          amount: "0",
          confidence: "0",
          reason: "手动拒绝",
        });

        const newMatches = await apiClient.matches.list("?page_size=500");
        const justCreated = newMatches.items.find(
          (m) =>
            m.expense_item_id === expenseItemId &&
            m.bank_transaction_id === selectedTransaction.id &&
            m.status === "candidate",
        );

        if (justCreated) {
          await apiClient.matches.reject(justCreated.id);
        }

        message.success("已拒绝此推荐");
        await loadData();
      } catch (error) {
        message.error(error instanceof Error ? error.message : "拒绝失败");
      } finally {
        setIsLoading(false);
      }
    },
    [selectedTransaction],
  );

  const handleManualSearch = useCallback(() => {
    message.info("手动搜索功能开发中...");
  }, []);

  const handleNext = useCallback(() => {
    if (!selectedTransaction) {
      const firstUnmatched = data.bankTransactions.find(
        (t) => Number(t.amount) - Number(t.matched_amount || 0) > 0,
      );
      if (firstUnmatched) {
        setSelectedTransaction(firstUnmatched);
      }
      return;
    }

    const currentIndex = data.bankTransactions.findIndex((t) => t.id === selectedTransaction.id);
    const nextUnmatched = data.bankTransactions
      .slice(currentIndex + 1)
      .find((t) => Number(t.amount) - Number(t.matched_amount || 0) > 0);

    if (nextUnmatched) {
      setSelectedTransaction(nextUnmatched);
    } else {
      // 从头开始找
      const firstUnmatched = data.bankTransactions.find(
        (t) => Number(t.amount) - Number(t.matched_amount || 0) > 0,
      );
      if (firstUnmatched && firstUnmatched.id !== selectedTransaction.id) {
        setSelectedTransaction(firstUnmatched);
      } else {
        message.info("没有更多未匹配流水");
      }
    }
  }, [selectedTransaction, data.bankTransactions]);

  const handleAutoSuggest = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await apiClient.matches.autoSuggest();
      message.success(
        `自动生成 ${result.created_count} 条候选匹配，跳过 ${result.skipped_count} 条已存在关系`,
      );
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "自动生成失败");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return (
    <AppShell
      title="匹配工作台"
      kicker="双栏工作模式"
      action={
        <Space>
          <Button onClick={handleAutoSuggest} loading={isLoading}>
            自动生成候选
          </Button>
        </Space>
      }
    >
      {errorMessage && (
        <Alert
          message={errorMessage}
          type="error"
          showIcon
          closable
          onClose={() => setErrorMessage(null)}
          style={{ marginBottom: "16px" }}
        />
      )}

      <Spin spinning={isLoading && !selectedTransaction}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "450px 1fr",
            gap: "16px",
            height: "calc(100vh - 200px)",
            minHeight: "600px",
          }}
          className="matching-workspace"
        >
          {/* 左侧：待匹配流水列表 */}
          <TransactionList
            transactions={data.bankTransactions}
            selectedId={selectedTransaction?.id || null}
            onSelect={handleSelectTransaction}
            loading={isLoading}
            stores={storesMap}
          />

          {/* 右侧：匹配详情和推荐面板 */}
          <MatchingPanel
            selectedTransaction={selectedTransaction}
            suggestions={suggestions}
            onConfirm={handleConfirm}
            onReject={handleReject}
            onManualSearch={handleManualSearch}
            onNext={handleNext}
            loading={isLoading}
            storeName={selectedTransaction ? storesMap.get(selectedTransaction.store_id)?.name : undefined}
          />
        </div>
      </Spin>

      {/* 添加响应式样式 */}
      <style jsx>{`
        @media (max-width: 1100px) {
          .matching-workspace {
            grid-template-columns: 1fr !important;
            grid-template-rows: 400px 1fr;
            height: auto !important;
            min-height: 800px !important;
          }
        }
      `}</style>
    </AppShell>
  );
}
