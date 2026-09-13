# 主数据模块实现说明

更新时间：2026-08-29

## 已实现范围

本阶段补齐后台做账前置主数据：

- 门店档案：支持门店基础信息、钉钉部门、联系人、地址维护。
- 费用分类：支持一级 / 二级分类维护。
- 供应商档案：支持供应商名称、收款账号、联系人、电话、备注。
- 主数据维护：支持编辑、启用、停用。
- 支出明细回填：支持对已有支出补分类、供应商和收款账号。

当前费用明细仍保留 `category_l1`、`category_l2`、`supplier_name` 文本字段，主数据作为标准录入来源使用。这样可以兼容钉钉同步、银行流水匹配和历史导入数据，不强制在一期改外键。

## API

### 门店档案

- `GET /api/stores?page=&page_size=`
- `POST /api/stores`
- `PATCH /api/stores/{store_id}`

支持更新：

- `name`
- `dingtalk_dept_id`
- `contact_person`
- `phone`
- `address`
- `status`

### 费用分类

- `GET /api/categories?page=&page_size=&parent_id=`
- `POST /api/categories`
- `PATCH /api/categories/{category_id}`

创建参数：

```json
{
  "name": "房租水电",
  "parent_id": null,
  "sort_order": 10
}
```

约束：

- `parent_id` 存在时必须指向已有分类。
- 分类不能把自己设置为上级分类。
- 同一父分类下分类名称不能重复。
- 支持更新 `name`、`parent_id`、`sort_order`、`status`。

### 供应商

- `GET /api/suppliers?page=&page_size=`
- `POST /api/suppliers`
- `PATCH /api/suppliers/{supplier_id}`

创建参数：

```json
{
  "name": "供电公司",
  "bank_account": "6222 **** 8899",
  "contact_name": "客服",
  "phone": "95598",
  "remark": "水电费供应商"
}
```

约束：

- 供应商名称不能重复。
- 支持更新 `name`、`bank_account`、`contact_name`、`phone`、`remark`、`status`。

### 支出明细更新

- `PATCH /api/expense-items/{item_id}`

可更新字段：

- `expense_date`
- `description`
- `amount`
- `category_l1`
- `category_l2`
- `supplier_name`
- `payee_account`

账套关闭后不允许更新支出明细。

## 后台页面

新增页面：

- `/stores`：门店列表、新增门店、编辑门店、启用、停用。
- `/categories`：费用分类列表、新增分类。
- `/categories`：支持编辑、启用、停用。
- `/suppliers`：供应商列表、新增供应商。
- `/suppliers`：支持编辑、启用、停用。
- `/revenue-channels`：收入渠道列表、新增渠道、编辑、启用、停用。

已增强页面：

- `/expenses`：新增支出时，一级分类和供应商从主数据下拉选择。
- `/expenses`：支持编辑支出日期、说明、金额、一级分类、二级分类、供应商和收款账号。
- `/expenses`：二级分类会按已选一级分类联动过滤。
- `/expenses`：已封账账套下的支出在页面禁用编辑，API 层也会拒绝更新。
- `/revenue`：新增和编辑收入时，渠道从启用的收入渠道主数据下拉选择。

## 数据库

迁移文件：

- `apps/api/alembic/versions/20260829_0005_master_data.py`
- `apps/api/alembic/versions/20260829_0009_revenue_channels.py`

新增表：

- `expense_categories`
- `suppliers`
- `revenue_channels`

本地 seed 会写入：

- 分类：房租水电 / 水电费 / 房租 / 营销物料 / 广告制作 / 运营杂费 / 维修维护。
- 供应商：供电公司、广告公司。

## 后续建议

- 增加分类和供应商的删除保护。
- 银行流水导入时基于收款账号自动建议供应商。
- 钉钉审批同步时基于映射字段自动标准化分类。
- 报表增加按分类、供应商的支出汇总。
