import { Button } from "antd";
import { PlusOutlined, FileTextOutlined, DownloadOutlined, FilterOutlined } from "@ant-design/icons";

interface PageAction {
  key: string;
  label: string;
  onClick: () => void;
  icon?: any;
  danger?: boolean;
}

interface QuickActionBarProps {
  primaryAction?: {
    label: string;
    icon?: any;
    onClick: () => void;
  };
  secondaryActions?: PageAction[];
  filterSlot?: any;
}

export function QuickActionBar({ primaryAction, secondaryActions, filterSlot }: QuickActionBarProps) {
  return (
    <div className="quick-action-bar">
      <div className="action-bar-left">{filterSlot}</div>

      <div className="action-bar-right">
        {secondaryActions?.map((action) => (
          <Button
            key={action.key}
            icon={action.icon}
            onClick={action.onClick}
            danger={action.danger}
          >
            {action.label}
          </Button>
        ))}

        {primaryAction && (
          <Button
            type="primary"
            icon={primaryAction.icon || <PlusOutlined />}
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </Button>
        )}
      </div>
    </div>
  );
}
