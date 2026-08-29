import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Card, Typography, Space } from "antd";

interface CategoryPieChartProps {
  title?: string;
  data: {
    name: string;
    value: number;
  }[];
  height?: number;
  loading?: boolean;
  showLegend?: boolean;
}

export function CategoryPieChart({
  title,
  data,
  height = 350,
  loading,
  showLegend = true,
}: CategoryPieChartProps) {
  // 计算总额
  const total = data.reduce((sum, item) => sum + item.value, 0);

  // 添加百分比
  const dataWithPercent = data.map((item) => ({
    ...item,
    percent: total > 0 ? ((item.value / total) * 100).toFixed(1) : "0.0",
  }));

  // 生成颜色方案
  const colors = [
    "#2a9d66",
    "#3b82f6",
    "#f59e0b",
    "#8b5cf6",
    "#ec4899",
    "#14b8a6",
    "#f97316",
    "#6366f1",
    "#10b981",
    "#ef4444",
  ];

  const option: EChartsOption = {
    color: colors,
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(255, 255, 255, 0.95)",
      borderColor: "#e5e7eb",
      textStyle: {
        color: "#374151",
      },
      formatter: (params: any) => {
        const value = Number(params.value).toLocaleString("zh-CN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        return `<div style="font-weight: 600; margin-bottom: 4px;">${params.name}</div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${params.color};"></span>
                  <span style="flex: 1;">金额</span>
                  <span style="font-weight: 600; font-family: monospace;">¥${value}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                  <span style="display: inline-block; width: 10px;"></span>
                  <span style="flex: 1;">占比</span>
                  <span style="font-weight: 600;">${params.percent}%</span>
                </div>`;
      },
    },
    legend: showLegend
      ? {
          orient: "vertical",
          right: 20,
          top: "center",
          textStyle: {
            color: "#6b7280",
            fontSize: 13,
          },
          formatter: (name: string) => {
            const item = dataWithPercent.find((d) => d.name === name);
            return item ? `${name} (${item.percent}%)` : name;
          },
        }
      : undefined,
    series: [
      {
        name: "支出分类",
        type: "pie",
        radius: ["45%", "70%"],
        center: showLegend ? ["35%", "50%"] : ["50%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: {
          borderRadius: 8,
          borderColor: "#fff",
          borderWidth: 2,
        },
        label: {
          show: !showLegend,
          position: "outside",
          formatter: "{b}\n{d}%",
          fontSize: 12,
          color: "#6b7280",
        },
        emphasis: {
          label: {
            show: true,
            fontSize: 14,
            fontWeight: "bold",
          },
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: "rgba(0, 0, 0, 0.3)",
          },
        },
        labelLine: {
          show: !showLegend,
          length: 15,
          length2: 10,
        },
        data: dataWithPercent,
      },
    ],
  };

  // 如果没有数据，显示空状态
  if (data.length === 0) {
    const emptyOption: EChartsOption = {
      title: {
        text: "暂无数据",
        left: "center",
        top: "center",
        textStyle: {
          color: "#9ca3af",
          fontSize: 14,
          fontWeight: "normal",
        },
      },
    };

    return title ? (
      <Card title={title}>
        <ReactECharts option={emptyOption} style={{ height }} />
      </Card>
    ) : (
      <ReactECharts option={emptyOption} style={{ height }} />
    );
  }

  if (!title) {
    return <ReactECharts option={option} style={{ height }} showLoading={loading} />;
  }

  return (
    <Card
      title={
        <Space>
          <Typography.Text strong style={{ fontSize: "16px" }}>
            {title}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: "13px" }}>
            总计 ¥{total.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Typography.Text>
        </Space>
      }
      loading={loading}
    >
      <ReactECharts option={option} style={{ height }} />
    </Card>
  );
}
