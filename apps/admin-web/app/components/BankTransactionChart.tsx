"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Card, Typography } from "antd";

interface BankTransactionChartProps {
  title?: string;
  data: {
    name: string;
    value: number;
  }[];
  height?: number;
  loading?: boolean;
}

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function BankTransactionChart({ title, data, height = 320, loading }: BankTransactionChartProps) {
  const option: EChartsOption = {
    color: ["#0f766e", "#ef4444", "#f59e0b"],
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      borderColor: "#e5e7eb",
      textStyle: { color: "#374151" },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return "";
        const item = params[0];
        return `<div style="font-weight:600;margin-bottom:6px;">${item.axisValue}</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${item.color};"></span>
            <span style="flex:1;">金额</span>
            <span style="font-weight:600;">¥${formatMoney(Number(item.value || 0))}</span>
          </div>`;
      },
    },
    grid: {
      left: 36,
      right: 20,
      top: 30,
      bottom: 24,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: data.map((item) => item.name),
      axisLine: { lineStyle: { color: "#e5e7eb" } },
      axisTick: { show: false },
      axisLabel: {
        color: "#6b7280",
        fontSize: 12,
      },
    },
    yAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: "#6b7280",
        fontSize: 12,
        formatter: (value: number) => {
          if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
          return value.toFixed(0);
        },
      },
      splitLine: {
        lineStyle: {
          color: "#f3f4f6",
          type: "dashed",
        },
      },
    },
    series: [
      {
        name: "金额",
        type: "bar",
        data: data.map((item) => ({
          value: item.value,
          itemStyle: {
            color: item.name === "收入流水" ? "#0f766e" : item.name === "支出流水" ? "#ef4444" : "#f59e0b",
          },
        })),
        barMaxWidth: 48,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
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
