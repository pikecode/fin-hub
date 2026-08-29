import { Empty, Button, Typography, Space } from "antd";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: any;
  primaryAction?: {
    label: string;
    onClick: () => void;
    icon?: any;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  type?: "default" | "search" | "error";
}

export function EmptyState({
  title,
  description,
  icon,
  primaryAction,
  secondaryAction,
  type = "default",
}: EmptyStateProps) {
  const getDefaultContent = () => {
    if (type === "search") {
      return {
        title: "未找到匹配的结果",
        description: "尝试修改搜索条件或清除筛选",
      };
    }
    if (type === "error") {
      return {
        title: "加载失败",
        description: "请检查网络连接或稍后重试",
      };
    }
    return {
      title: "暂无数据",
      description: "当前没有可显示的内容",
    };
  };

  const content = getDefaultContent();
  const finalTitle = title || content.title;
  const finalDescription = description || content.description;

  return (
    <div
      style={{
        padding: "64px 24px",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon ? (
        <div style={{ marginBottom: "24px", fontSize: "64px", opacity: 0.3 }}>{icon}</div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="" />
      )}

      <Space direction="vertical" size={12} style={{ marginTop: "16px" }}>
        <Typography.Title level={4} style={{ margin: 0, color: "#374151" }}>
          {finalTitle}
        </Typography.Title>

        <Typography.Text type="secondary" style={{ fontSize: "14px" }}>
          {finalDescription}
        </Typography.Text>

        {(primaryAction || secondaryAction) && (
          <Space size={12} style={{ marginTop: "24px" }}>
            {primaryAction && (
              <Button type="primary" icon={primaryAction.icon} onClick={primaryAction.onClick}>
                {primaryAction.label}
              </Button>
            )}
            {secondaryAction && (
              <Button type="default" onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </Button>
            )}
          </Space>
        )}
      </Space>
    </div>
  );
}
