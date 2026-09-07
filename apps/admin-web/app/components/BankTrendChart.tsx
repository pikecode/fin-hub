"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Card, Typography } from "antd";

interface BankTrendChartProps {
  title?: string;
  data: {
    period: string;
    bank_expense_amount: number;
    matched_expense_amount: number;
    unmatched_bank_amount: number;
    bank_transaction_count: number;
  }[];
  height?: number;
  loading?: boolean;
}

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCount(value: number) {
  return value.toLocaleString("zh-CN");
}

export function BankTrendChart({ title, data, height = 340, loading }: BankTrendChartProps) {
  const option: EChartsOption = {
    color: ["#ef4444", "#0f766e", "#f59e0b", "#3b82f6"],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      borderColor: "#e5e7eb",
      textStyle: { color: "#374151" },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return "";
        const period = params[0].axisValue;
        const row = data.find((item) => item.period === period);
        if (!row) return "";
        return `<div style="font-weight:600;margin-bottom:8px;">${period}</div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#ef4444;"></span><span style="flex:1;">银行支出</span><span style="font-weight:600;">¥${formatMoney(row.bank_expense_amount)}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#0f766e;"></span><span style="flex:1;">已对账金额</span><span style="font-weight:600;">¥${formatMoney(row.matched_expense_amount)}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#f59e0b;"></span><span style="flex:1;">未对账金额</span><span style="font-weight:600;">¥${formatMoney(row.unmatched_bank_amount)}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#3b82f6;"></span><span style="flex:1;">流水笔数</span><span style="font-weight:600;">${formatCount(row.bank_transaction_count)}</span></div>`;
      },
    },
    legend: {
      top: 10,
      data: ["银行支出", "已对账金额", "未对账金额", "流水笔数"],
      textStyle: { color: "#6b7280", fontSize: 12 },
    },
    grid: { left: 56, right: 44, top: 60, bottom: 44, containLabel: true },
    xAxis: {
      type: "category",
      data: data.map((item) => item.period),
      axisLine: { lineStyle: { color: "#e5e7eb" } },
      axisTick: { show: false },
      axisLabel: { color: "#6b7280", fontSize: 12 },
    },
    yAxis: [
      {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: "#6b7280",
          fontSize: 12,
          formatter: (value: number) => (value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value.toFixed(0)),
        },
        splitLine: { lineStyle: { color: "#f3f4f6", type: "dashed" } },
      },
      {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#6b7280", fontSize: 12 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "银行支出",
        type: "bar",
        data: data.map((item) => item.bank_expense_amount),
        barMaxWidth: 24,
      },
      {
        name: "已对账金额",
        type: "bar",
        data: data.map((item) => item.matched_expense_amount),
        barMaxWidth: 24,
      },
      {
        name: "未对账金额",
        type: "bar",
        data: data.map((item) => item.unmatched_bank_amount),
        barMaxWidth: 24,
      },
      {
        name: "流水笔数",
        type: "line",
        yAxisIndex: 1,
        data: data.map((item) => item.bank_transaction_count),
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 3 },
      },
    ],
  };

  if (!title) {
    return <ReactECharts option={option} style={{ height }} showLoading={loading} />;
  }

  return (
    <Card
      title={
        <Typography.Text strong style={{ fontSize: "16px" }}>
          {title}
        </Typography.Text>
      }
      loading={loading}
    >
      <ReactECharts option={option} style={{ height }} />
    </Card>
  );
}
