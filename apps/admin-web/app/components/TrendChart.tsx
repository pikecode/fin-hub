import ReactECharts from "echarts-for-react";
import type { EChartsOption, SeriesOption } from "echarts";
import { Card, Typography } from "antd";

interface TrendChartProps {
  title?: string;
  data: {
    periods: string[];
    revenue: number[];
    expense: number[];
    profit?: number[];
  };
  height?: number;
  loading?: boolean;
}

export function TrendChart({ title, data, height = 350, loading }: TrendChartProps) {
  const series: SeriesOption[] = [
    {
      name: "营业收入",
      type: "line",
      data: data.revenue,
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: {
        width: 3,
      },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            {
              offset: 0,
              color: "rgba(42, 157, 102, 0.2)",
            },
            {
              offset: 1,
              color: "rgba(42, 157, 102, 0.02)",
            },
          ],
        },
      },
      emphasis: {
        focus: "series",
      },
    },
    {
      name: "总支出",
      type: "line",
      data: data.expense,
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: {
        width: 3,
      },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            {
              offset: 0,
              color: "rgba(239, 68, 68, 0.2)",
            },
            {
              offset: 1,
              color: "rgba(239, 68, 68, 0.02)",
            },
          ],
        },
      },
      emphasis: {
        focus: "series",
      },
    },
  ];

  if (data.profit) {
    series.push({
      name: "利润",
      type: "line",
      data: data.profit,
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: {
        width: 3,
        type: "dashed",
      },
      emphasis: {
        focus: "series",
      },
    });
  }

  const option: EChartsOption = {
    color: ["#2a9d66", "#ef4444", "#3b82f6"],
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
      },
      backgroundColor: "rgba(255, 255, 255, 0.95)",
      borderColor: "#e5e7eb",
      textStyle: {
        color: "#374151",
      },
      formatter: (params: any) => {
        if (!Array.isArray(params)) return "";
        let result = `<div style="font-weight: 600; margin-bottom: 8px;">${params[0].axisValue}</div>`;
        params.forEach((item: any) => {
          const value = Number(item.value).toLocaleString("zh-CN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          result += `<div style="display: flex; align-items: center; gap: 8px; margin: 4px 0;">
            <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${item.color};"></span>
            <span style="flex: 1;">${item.seriesName}</span>
            <span style="font-weight: 600;">¥${value}</span>
          </div>`;
        });
        return result;
      },
    },
    legend: {
      data: ["营业收入", "总支出", "利润"],
      top: 10,
      textStyle: {
        color: "#6b7280",
        fontSize: 13,
      },
    },
    grid: {
      left: 60,
      right: 40,
      top: 60,
      bottom: 50,
      containLabel: false,
    },
    xAxis: {
      type: "category",
      data: data.periods,
      boundaryGap: false,
      axisLine: {
        lineStyle: {
          color: "#e5e7eb",
        },
      },
      axisLabel: {
        color: "#6b7280",
        fontSize: 12,
      },
      axisTick: {
        show: false,
      },
    },
    yAxis: {
      type: "value",
      axisLine: {
        show: false,
      },
      axisLabel: {
        color: "#6b7280",
        fontSize: 12,
        formatter: (value: number) => {
          if (value >= 10000) {
            return (value / 10000).toFixed(1) + "万";
          }
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
