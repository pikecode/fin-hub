"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Card, Typography } from "antd";

interface ExpenseCategoryBarChartProps {
  title?: string;
  data: Array<{ name: string; value: number }>;
  height?: number;
  loading?: boolean;
}

function money(value: number) {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ExpenseCategoryBarChart({ title, data, height = 330, loading }: ExpenseCategoryBarChartProps) {
  const sorted = [...data].sort((left, right) => right.value - left.value).slice(0, 10);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const option: EChartsOption = {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: any) => {
        const item = sorted[params?.[0]?.dataIndex ?? 0];
        if (!item) return "";
        const share = total > 0 ? ((item.value / total) * 100).toFixed(2) : "0.00";
        return `<strong>${item.name}</strong><br/>金额：${money(item.value)}<br/>占当前分类：${share}%`;
      },
    },
    grid: { left: 10, right: 82, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: "value", max: "dataMax", show: false },
    yAxis: {
      type: "category",
      inverse: true,
      data: sorted.map((item) => item.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: "#475569", fontSize: 13, width: 115, overflow: "truncate" },
    },
    series: [
      {
        type: "bar",
        data: sorted.map((item) => item.value),
        barMaxWidth: 22,
        showBackground: true,
        backgroundStyle: { color: "#f1f5f9", borderRadius: 99 },
        itemStyle: { color: "#d9482b", borderRadius: [0, 99, 99, 0] },
        label: {
          show: true,
          position: "right",
          color: "#334155",
          fontSize: 12,
          formatter: (params: any) => money(Number(params.value)),
        },
      },
    ],
  };

  const chart = sorted.length ? <ReactECharts option={option} style={{ height }} showLoading={loading} /> : <div style={{ height, display: "grid", placeItems: "center", color: "#94a3b8" }}>暂无费用数据</div>;
  if (!title) return chart;
  return <Card title={<Typography.Text strong style={{ fontSize: 16 }}> {title} </Typography.Text>} extra={<Typography.Text type="secondary">合计 {money(total)}</Typography.Text>} loading={loading}>{chart}</Card>;
}
