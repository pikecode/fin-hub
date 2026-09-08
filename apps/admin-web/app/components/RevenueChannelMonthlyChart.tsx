"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption, SeriesOption } from "echarts";
import { Card, Typography } from "antd";

interface RevenueChannelMonthlyChartProps {
  title?: string;
  data: {
    period: string;
    channel: string;
    gross_amount: string;
    net_amount: string;
    record_count: number;
  }[];
  height?: number;
  loading?: boolean;
}

const palette = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#059669", "#d97706", "#334155"];

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function RevenueChannelMonthlyChart({ title, data, height = 420, loading }: RevenueChannelMonthlyChartProps) {
  const periods = Array.from(new Set(data.map((item) => item.period))).sort();
  const channels = Array.from(new Set(data.map((item) => item.channel))).sort();
  const matrix = new Map<string, Map<string, typeof data[number]>>();

  data.forEach((item) => {
    if (!matrix.has(item.period)) {
      matrix.set(item.period, new Map());
    }
    matrix.get(item.period)?.set(item.channel, item);
  });

  const series: SeriesOption[] = periods.map((period, index) => ({
    name: period,
    type: "bar",
    barMaxWidth: 36,
    itemStyle: {
      borderRadius: [4, 4, 0, 0],
      color: palette[index % palette.length],
    },
    emphasis: {
      focus: "series",
    },
    data: channels.map((channel) => Number(matrix.get(period)?.get(channel)?.gross_amount || 0)),
  }));

  const option: EChartsOption = {
    color: palette,
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "shadow",
      },
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      borderColor: "#e5e7eb",
      textStyle: {
        color: "#374151",
      },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return "";
        const channel = params[0].axisValue;
        let html = `<div style="font-weight: 600; margin-bottom: 8px;">${channel}</div>`;
        params.forEach((item: any) => {
          const row = matrix.get(item.seriesName)?.get(channel);
          const gross = Number(row?.gross_amount || 0);
          const net = Number(row?.net_amount || 0);
          html += `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${item.color};"></span>
            <span style="flex:1;">${item.seriesName}</span>
            <span style="font-weight:600;">经营收入 ¥${formatMoney(gross)}</span>
            <span style="color:#6b7280;">实收 ¥${formatMoney(net)}</span>
          </div>`;
        });
        return html;
      },
    },
    legend: {
      type: "scroll",
      top: 10,
      textStyle: {
        color: "#6b7280",
        fontSize: 12,
      },
    },
    grid: {
      left: 48,
      right: 24,
      top: 60,
      bottom: 42,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: channels,
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
    series,
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
