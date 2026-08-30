import { Input, Select, Button, Tag, Drawer, Space, DatePicker, Dropdown, Form } from "antd";
import { FilterOutlined, SearchOutlined, StarOutlined, CloseOutlined, SaveOutlined } from "@ant-design/icons";
import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import dayjs from "dayjs";

export type FilterType = "text" | "select" | "date" | "dateRange" | "number" | "numberRange";

export interface FilterConfig {
  key: string;
  label: string;
  type: FilterType;
  placeholder?: string;
  options?: { label: string; value: any }[];
  defaultValue?: any;
}

export interface SavedFilter {
  id: string;
  name: string;
  values: Record<string, any>;
}

export interface SmartFilterBarProps {
  filters: FilterConfig[];
  value?: Record<string, any>;
  onChange?: (values: Record<string, any>) => void;
  savedFilters?: SavedFilter[];
  onSaveFilter?: (name: string, values: Record<string, any>) => void;
  onLoadFilter?: (filter: SavedFilter) => void;
  onDeleteFilter?: (id: string) => void;
  searchable?: boolean;
  onSearch?: (keyword: string) => void;
  collapsible?: boolean;
}

export function SmartFilterBar({
  filters,
  value = {},
  onChange,
  savedFilters = [],
  onSaveFilter,
  onLoadFilter,
  onDeleteFilter,
  searchable = true,
  onSearch,
  collapsible = true,
}: SmartFilterBarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");
  const [localValues, setLocalValues] = useState<Record<string, any>>(value);

  // 快速筛选（前3个）
  const quickFilters = filters.slice(0, 3);
  // 高级筛选（其余）
  const advancedFilters = filters.slice(3);

  // 活跃的筛选器
  const activeFilters = useMemo(() => {
    return Object.entries(localValues)
      .filter(([_, val]) => val !== undefined && val !== null && val !== "")
      .map(([key, val]) => {
        const filter = filters.find((f) => f.key === key);
        return {
          key,
          label: filter?.label || key,
          displayValue: formatDisplayValue(val, filter?.type),
          value: val,
        };
      });
  }, [localValues, filters]);

  function formatDisplayValue(value: any, type?: FilterType): string {
    if (Array.isArray(value)) {
      if (type === "dateRange") {
        return `${dayjs(value[0]).format("YYYY-MM-DD")} ~ ${dayjs(value[1]).format("YYYY-MM-DD")}`;
      }
      return value.join(", ");
    }
    if (dayjs.isDayjs(value)) {
      return value.format("YYYY-MM-DD");
    }
    return String(value);
  }

  function handleFilterChange(key: string, val: any) {
    const newValues = { ...localValues, [key]: val };
    setLocalValues(newValues);
    onChange?.(newValues);
  }

  function handleRemoveFilter(key: string) {
    const newValues = { ...localValues };
    delete newValues[key];
    setLocalValues(newValues);
    onChange?.(newValues);
  }

  function handleClearAll() {
    setLocalValues({});
    onChange?.({});
  }

  function handleSaveFilter() {
    if (saveFilterName.trim()) {
      onSaveFilter?.(saveFilterName, localValues);
      setSaveFilterName("");
    }
  }

  function renderFilterInput(filter: FilterConfig) {
    const val = localValues[filter.key];

    switch (filter.type) {
      case "select":
        return (
          <Select
            placeholder={filter.placeholder || `选择${filter.label}`}
            value={val}
            onChange={(v) => handleFilterChange(filter.key, v)}
            options={filter.options}
            allowClear
            style={{ minWidth: 150 }}
          />
        );

      case "date":
        return (
          <DatePicker
            placeholder={filter.placeholder || `选择${filter.label}`}
            value={val ? dayjs(val) : null}
            onChange={(date) => handleFilterChange(filter.key, date?.toISOString())}
            style={{ minWidth: 150 }}
          />
        );

      case "dateRange":
        return (
          <DatePicker.RangePicker
            placeholder={["开始日期", "结束日期"]}
            value={val ? [dayjs(val[0]), dayjs(val[1])] : null}
            onChange={(dates) =>
              handleFilterChange(
                filter.key,
                dates ? [dates[0]?.toISOString(), dates[1]?.toISOString()] : null
              )
            }
            style={{ minWidth: 220 }}
          />
        );

      case "number":
      case "text":
      default:
        return (
          <Input
            placeholder={filter.placeholder || `输入${filter.label}`}
            value={val}
            onChange={(e) => handleFilterChange(filter.key, e.target.value)}
            allowClear
            style={{ minWidth: 150 }}
          />
        );
    }
  }

  const savedFiltersMenu = {
    items: savedFilters.map((filter) => ({
      key: filter.id,
      label: (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span>{filter.name}</span>
          <Button
            type="text"
            size="small"
            danger
            icon={<CloseOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              onDeleteFilter?.(filter.id);
            }}
          />
        </div>
      ),
      onClick: () => onLoadFilter?.(filter),
    })),
  };

  return (
    <div className="smart-filter-bar">
      {/* 快速筛选区 */}
      <div className="quick-filters">
        {/* 快速筛选字段 */}
        <Space size={8} wrap>
          {quickFilters.map((filter) => (
            <div key={filter.key} className="filter-input-wrapper">
              {renderFilterInput(filter)}
            </div>
          ))}

          {/* 全局搜索 */}
          {searchable && (
            <Input.Search
              placeholder="搜索所有字段..."
              onSearch={onSearch}
              style={{ width: 200 }}
              allowClear
            />
          )}

          {/* 展开高级筛选 */}
          {collapsible && advancedFilters.length > 0 && (
            <Button
              type={advancedOpen ? "primary" : "default"}
              icon={<FilterOutlined />}
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              高级筛选
              {activeFilters.length > 0 && ` (${activeFilters.length})`}
            </Button>
          )}

          {/* 保存的筛选方案 */}
          {savedFilters.length > 0 && (
            <Dropdown menu={savedFiltersMenu} placement="bottomLeft">
              <Button icon={<StarOutlined />}>常用筛选</Button>
            </Dropdown>
          )}

          {/* 清空按钮 */}
          {activeFilters.length > 0 && (
            <Button onClick={handleClearAll}>清空</Button>
          )}
        </Space>
      </div>

      {/* 活跃的筛选标签 */}
      {activeFilters.length > 0 && (
        <div className="active-filters">
          <Space size={8} wrap>
            {activeFilters.map((filter) => (
              <Tag
                key={filter.key}
                closable
                onClose={() => handleRemoveFilter(filter.key)}
                color="blue"
              >
                {filter.label}: {filter.displayValue}
              </Tag>
            ))}
          </Space>
        </div>
      )}

      {/* 高级筛选抽屉 */}
      <Drawer
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        title="高级筛选"
        width={480}
        footer={
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Button onClick={handleClearAll}>清空全部</Button>
            <Space>
              <Button onClick={() => setAdvancedOpen(false)}>取消</Button>
              <Button type="primary" onClick={() => setAdvancedOpen(false)}>
                应用筛选
              </Button>
            </Space>
          </Space>
        }
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {advancedFilters.map((filter) => (
            <div key={filter.key}>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 600, color: "#525252" }}>
                {filter.label}
              </label>
              {renderFilterInput(filter)}
            </div>
          ))}

          <div style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid #e5e5e5" }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600, color: "#525252" }}>
              保存此筛选方案
            </label>
            <Space.Compact style={{ width: "100%" }}>
              <Input
                placeholder="筛选方案名称"
                value={saveFilterName}
                onChange={(e) => setSaveFilterName(e.target.value)}
              />
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={handleSaveFilter}
                disabled={!saveFilterName.trim()}
              >
                保存
              </Button>
            </Space.Compact>
          </div>
        </Space>
      </Drawer>
    </div>
  );
}
