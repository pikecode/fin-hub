import { Table, Checkbox, Space, Button, Dropdown, Tag, Segmented } from "antd";
import type { MenuProps } from "antd";
import type { TableProps, ColumnsType, ColumnType } from "antd/es/table";
import { DownloadOutlined, MoreOutlined, SettingOutlined } from "@ant-design/icons";
import { useState, useMemo } from "react";
import type { Key } from "react";

export type TableDensity = "compact" | "default" | "comfortable";

export interface BatchAction {
  key: string;
  label: string;
  icon?: any;
  danger?: boolean;
  onClick: (selectedKeys: Key[], selectedRows: any[]) => void;
}

export interface EnterpriseTableColumn<T> extends Omit<ColumnType<T>, "key"> {
  key: string;
  filterable?: boolean;
  filterType?: "text" | "select" | "range" | "date" | "checkbox";
  filterOptions?: { label: string; value: any }[];
}

export interface EnterpriseTableProps<T> extends Omit<TableProps<T>, "columns"> {
  columns: EnterpriseTableColumn<T>[];

  // 批量操作
  batchActions?: BatchAction[];
  onBatchAction?: (action: string, keys: Key[], rows: T[]) => void;

  // 密度切换
  density?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;
  showDensityToggle?: boolean;

  // 导出
  exportable?: boolean;
  onExport?: (format: "csv" | "excel" | "json") => void;

  // 列设置
  showColumnSettings?: boolean;

  // 固定列
  fixedColumns?: {
    left?: string[];
    right?: string[];
  };
}

export function EnterpriseTable<T extends Record<string, any>>({
  columns,
  dataSource = [],
  batchActions,
  onBatchAction,
  density = "default",
  onDensityChange,
  showDensityToggle = true,
  exportable = false,
  onExport,
  showColumnSettings = false,
  fixedColumns,
  rowSelection,
  ...restProps
}: EnterpriseTableProps<T>) {
  const tableDataSource = Array.from(dataSource as readonly T[]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [selectedRows, setSelectedRows] = useState<T[]>([]);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    new Set(columns.map((col) => col.key))
  );

  // 处理固定列
  const processedColumns = useMemo(() => {
    return columns.map((col) => {
      const processed = { ...col };

      // 应用固定列设置
      if (fixedColumns?.left?.includes(col.key)) {
        processed.fixed = "left";
      } else if (fixedColumns?.right?.includes(col.key)) {
        processed.fixed = "right";
      }

      // 应用列可见性
      if (!visibleColumns.has(col.key)) {
        return null;
      }

      return processed;
    }).filter(Boolean) as ColumnsType<T>;
  }, [columns, fixedColumns, visibleColumns]);

  // 行选择配置
  const tableRowSelection = useMemo(() => {
    if (!batchActions || batchActions.length === 0) {
      return rowSelection;
    }

    return {
      selectedRowKeys,
      onChange: (keys: Key[], rows: T[]) => {
        setSelectedRowKeys(keys);
        setSelectedRows(rows);
        rowSelection?.onChange?.(keys, rows, {} as any);
      },
      ...rowSelection,
    };
  }, [batchActions, selectedRowKeys, rowSelection]);

  // 根据密度调整表格大小
  const tableSize = useMemo(() => {
    if (density === "compact") return "small";
    if (density === "comfortable") return "large";
    return "middle";
  }, [density]);

  // 导出菜单
  const exportMenu: MenuProps = {
    items: [
      { key: "csv", label: "导出为 CSV" },
      { key: "excel", label: "导出为 Excel" },
      { key: "json", label: "导出为 JSON" },
    ],
    onClick: ({ key }: { key: string }) => {
      onExport?.(key as "csv" | "excel" | "json");
    },
  };

  // 列设置菜单
  const columnMenu: MenuProps = {
    items: columns.map((col) => ({
      key: col.key,
      label: (
        <Checkbox
          checked={visibleColumns.has(col.key)}
          onChange={(e) => {
            const newVisible = new Set(visibleColumns);
            if (e.target.checked) {
              newVisible.add(col.key);
            } else {
              newVisible.delete(col.key);
            }
            setVisibleColumns(newVisible);
          }}
        >
          {col.title as string}
        </Checkbox>
      ),
    })),
  };

  // 批量操作菜单
  const batchMenu: MenuProps = {
    items: batchActions?.map((action) => ({
      key: action.key,
      label: action.label,
      icon: action.icon,
      danger: action.danger,
      onClick: () => {
        action.onClick(selectedRowKeys, selectedRows);
      },
    })),
  };

  return (
    <div className="enterprise-table-wrapper">
      {/* 工具栏 */}
      <div className="table-toolbar">
        <div className="toolbar-left">
          {selectedRowKeys.length > 0 ? (
            <div className="batch-info">
              <Checkbox
                indeterminate={selectedRowKeys.length > 0 && selectedRowKeys.length < tableDataSource.length}
                checked={selectedRowKeys.length === tableDataSource.length && tableDataSource.length > 0}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedRowKeys(tableDataSource.map((item) => item.key || item.id));
                    setSelectedRows(tableDataSource);
                  } else {
                    setSelectedRowKeys([]);
                    setSelectedRows([]);
                  }
                }}
              />
              <span className="batch-count">
                已选 <strong>{selectedRowKeys.length}</strong> 项
              </span>
            </div>
          ) : (
            <span className="table-total">
              共 <strong>{tableDataSource.length}</strong> 条数据
            </span>
          )}
        </div>

        <div className="toolbar-right">
          <Space size={8}>
            {/* 批量操作 */}
            {selectedRowKeys.length > 0 && batchActions && batchActions.length > 0 && (
              <Dropdown menu={batchMenu} placement="bottomRight">
                <Button icon={<MoreOutlined />}>批量操作</Button>
              </Dropdown>
            )}

            {/* 密度切换 */}
            {showDensityToggle && (
              <Segmented
                size="small"
                value={density}
                onChange={(value) => onDensityChange?.(value as TableDensity)}
                options={[
                  { label: "紧凑", value: "compact" },
                  { label: "默认", value: "default" },
                  { label: "宽松", value: "comfortable" },
                ]}
              />
            )}

            {/* 导出 */}
            {exportable && (
              <Dropdown menu={exportMenu} placement="bottomRight">
                <Button icon={<DownloadOutlined />}>导出</Button>
              </Dropdown>
            )}

            {/* 列设置 */}
            {showColumnSettings && (
              <Dropdown menu={columnMenu} placement="bottomRight" trigger={["click"]}>
                <Button icon={<SettingOutlined />}>列设置</Button>
              </Dropdown>
            )}
          </Space>
        </div>
      </div>

      {/* 表格 */}
      <Table<T>
        columns={processedColumns}
        dataSource={dataSource}
        rowSelection={tableRowSelection}
        size={tableSize}
        scroll={{ x: "max-content" }}
        {...restProps}
      />

      {/* 批量操作浮动栏 */}
      {selectedRowKeys.length > 0 && batchActions && batchActions.length > 0 && (
        <div className="batch-action-bar">
          <div className="batch-action-left">
            <Checkbox
              indeterminate={selectedRowKeys.length > 0 && selectedRowKeys.length < tableDataSource.length}
              checked={selectedRowKeys.length === tableDataSource.length}
              onChange={(e) => {
                if (e.target.checked) {
                  setSelectedRowKeys(tableDataSource.map((item) => item.key || item.id));
                  setSelectedRows(tableDataSource);
                } else {
                  setSelectedRowKeys([]);
                  setSelectedRows([]);
                }
              }}
            />
            <span className="batch-count">
              已选 <strong>{selectedRowKeys.length}</strong> 项
            </span>
          </div>

          <div className="batch-action-buttons">
            <Space size={12}>
              {batchActions.map((action) => (
                <Button
                  key={action.key}
                  icon={action.icon}
                  onClick={() => action.onClick(selectedRowKeys, selectedRows)}
                  danger={action.danger}
                >
                  {action.label}
                </Button>
              ))}
            </Space>
          </div>

          <Button
            type="text"
            onClick={() => {
              setSelectedRowKeys([]);
              setSelectedRows([]);
            }}
          >
            取消
          </Button>
        </div>
      )}
    </div>
  );
}
