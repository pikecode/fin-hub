"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Card, Typography } from "antd";

interface ApprovalStatusChartProps {
  title?: string;
  data: {
    status: string;
    count: number;
    amount: string;
  }[];
  height?: number;
  loading?: boolean;
}

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const statusLabels: Record<string, string> = {
  matched: "已匹配",
  unmatched: "未匹配",
};

const colors = ["#9ca3af", "#f59e0b", "#3b82f6", "#10b981", "#14b8a6", "#ef4444"];

export function ApprovalStatusChart({ title, data, height = 320, loading }: ApprovalStatusChartProps) {
  const chartData = data.map((item, index) => ({
    name: statusLabels[item.status] ?? item.status,
    value: item.count,
    rawAmount: Number(item.amount || 0),
    status: item.status,
    itemStyle: { color: colors[index % colors.length] },
  }));
  const total = chartData.reduce((sum, item) => sum + item.value, 0);

  const option: EChartsOption = {
    color: colors,
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      borderColor: "#e5e7eb",
      textStyle: { color: "#374151" },
      formatter: (params: any) => {
        const value = Number(params.value || 0);
        const rawAmount = Number(params.data?.rawAmount || 0);
        return `<div style="font-weight:600;margin-bottom:6px;">${params.name}</div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${params.color};"></span><span style="flex:1;">审批数</span><span style="font-weight:600;">${value}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;"></span><span style="flex:1;">金额</span><span style="font-weight:600;">¥${formatMoney(rawAmount)}</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="display:inline-block;width:10px;"></span><span style="flex:1;">占比</span><span style="font-weight:600;">${total > 0 ? ((value / total) * 100).toFixed(1) : "0.0"}%</span></div>`;
      },
    },
    legend: {
      orient: "vertical",
      right: 18,
      top: "center",
      textStyle: { color: "#6b7280", fontSize: 12 },
      formatter: (name: string) => {
        const item = chartData.find((row) => row.name === name);
        return item ? `${name} (${item.value})` : name;
      },
    },
    series: [
      {
        name: "审批状态",
        type: "pie",
        radius: ["42%", "68%"],
        center: ["36%", "50%"],
        avoidLabelOverlap: true,
        label: {
          formatter: "{b}\n{d}%",
          fontSize: 12,
          color: "#64748b",
        },
        labelLine: {
          length: 14,
          length2: 10,
        },
        itemStyle: {
          borderRadius: 8,
          borderColor: "#fff",
          borderWidth: 2,
        },
        data: chartData,
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
