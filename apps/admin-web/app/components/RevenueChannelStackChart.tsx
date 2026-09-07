"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Card, Typography } from "antd";

interface RevenueChannelStackChartProps {
  title?: string;
  data: {
    channel: string;
    gross_amount: string;
    net_amount: string;
    fee_amount: string;
    fee_rate: string;
    matched_amount: string;
    unmatched_amount: string;
    reconciliation_rate: string;
    record_count: number;
  }[];
  height?: number;
  loading?: boolean;
}

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

export function RevenueChannelStackChart({ title, data, height = 360, loading }: RevenueChannelStackChartProps) {
  const channels = data.map((item) => item.channel).reverse();
  const netAmounts = data.map((item) => Number(item.net_amount || 0)).reverse();
  const feeAmounts = data.map((item) => Number(item.fee_amount || 0)).reverse();

  const option: EChartsOption = {
    color: ["#0f766e", "#f59e0b"],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      borderColor: "#e5e7eb",
      textStyle: { color: "#374151" },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return "";
        const index = params[0].dataIndex ?? 0;
        const item = data[data.length - 1 - index];
        if (!item) return "";
        return `<div style="font-weight:600;margin-bottom:8px;">${item.channel}</div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#0f766e;"></span><span style="flex:1;">实收</span><span style="font-weight:600;">¥${formatMoney(Number(item.net_amount || 0))}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#f59e0b;"></span><span style="flex:1;">手续费</span><span style="font-weight:600;">¥${formatMoney(Number(item.fee_amount || 0))}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#334155;"></span><span style="flex:1;">经营收入</span><span style="font-weight:600;">¥${formatMoney(Number(item.gross_amount || 0))}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;"></span><span style="flex:1;">费率</span><span style="font-weight:600;">${item.fee_rate}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;"></span><span style="flex:1;">对账率</span><span style="font-weight:600;">${item.reconciliation_rate}</span></div>`;
      },
    },
    legend: {
      top: 10,
      data: ["实收", "手续费"],
      textStyle: {
        color: "#6b7280",
        fontSize: 12,
      },
    },
    grid: {
      left: 90,
      right: 24,
      top: 56,
      bottom: 20,
      containLabel: true,
    },
    xAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: "#6b7280",
        fontSize: 12,
        formatter: (value: number) => (value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value.toFixed(0)),
      },
      splitLine: {
        lineStyle: {
          color: "#f3f4f6",
          type: "dashed",
        },
      },
    },
    yAxis: {
      type: "category",
      data: channels,
      axisLine: { lineStyle: { color: "#e5e7eb" } },
      axisTick: { show: false },
      axisLabel: {
        color: "#334155",
        fontSize: 12,
      },
    },
    series: [
      {
        name: "实收",
        type: "bar",
        stack: "revenue",
        data: netAmounts,
        barMaxWidth: 24,
        itemStyle: {
          borderRadius: [0, 0, 0, 0],
        },
      },
      {
        name: "手续费",
        type: "bar",
        stack: "revenue",
        data: feeAmounts,
        barMaxWidth: 24,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
        },
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
