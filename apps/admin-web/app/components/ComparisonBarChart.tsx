import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Card, Typography } from "antd";

interface ComparisonBarChartProps {
  title?: string;
  data: {
    name: string;
    revenue: number;
    expense: number;
    profit: number;
  }[];
  height?: number;
  loading?: boolean;
  horizontal?: boolean;
}

export function ComparisonBarChart({
  title,
  data,
  height = 400,
  loading,
  horizontal = false,
}: ComparisonBarChartProps) {
  const names = data.map((d) => d.name);
  const revenueData = data.map((d) => d.revenue);
  const expenseData = data.map((d) => d.expense);
  const profitData = data.map((d) => d.profit);

  const option: EChartsOption = {
    color: ["#2a9d66", "#ef4444", "#3b82f6"],
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "shadow",
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
            <span style="display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: ${item.color};"></span>
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
      left: horizontal ? 100 : 60,
      right: 40,
      top: 60,
      bottom: 50,
      containLabel: false,
    },
    xAxis: horizontal
      ? {
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
        }
      : {
          type: "category",
          data: names,
          axisLine: {
            lineStyle: {
              color: "#e5e7eb",
            },
          },
          axisLabel: {
            color: "#6b7280",
            fontSize: 12,
            interval: 0,
            rotate: names.length > 5 ? 45 : 0,
          },
          axisTick: {
            show: false,
          },
        },
    yAxis: horizontal
      ? {
          type: "category",
          data: names,
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
        }
      : {
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
    series: [
      {
        name: "营业收入",
        type: "bar",
        data: revenueData,
        barMaxWidth: 40,
        itemStyle: {
          borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        },
        emphasis: {
          focus: "series",
        },
      },
      {
        name: "总支出",
        type: "bar",
        data: expenseData,
        barMaxWidth: 40,
        itemStyle: {
          borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        },
        emphasis: {
          focus: "series",
        },
      },
      {
        name: "利润",
        type: "bar",
        data: profitData,
        barMaxWidth: 40,
        itemStyle: {
          borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        },
        emphasis: {
          focus: "series",
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
