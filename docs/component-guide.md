# 新增组件使用指南

快速参考手册，帮助你在项目中使用优化后的组件。

---

## 📦 组件清单

### 基础展示组件

| 组件 | 用途 | 位置 |
|-----|------|------|
| MetricCard | 仪表盘指标卡片 | `components/MetricCard.tsx` |
| MoneyDisplay | 统一金额显示 | `components/MoneyDisplay.tsx` |
| StatusBadge | 状态徽章 | `components/StatusBadge.tsx` |
| EmptyState | 空状态占位 | `components/EmptyState.tsx` |

### 业务组件

| 组件 | 用途 | 位置 |
|-----|------|------|
| TransactionList | 银行流水列表（左侧面板） | `components/TransactionList.tsx` |
| MatchingPanel | 匹配推荐面板（右侧面板） | `components/MatchingPanel.tsx` |

---

## 🚀 快速开始

### 1. MetricCard - 指标卡片

**适用场景：** 仪表盘、数据概览、关键指标展示

**基础用法**
```tsx
import { MetricCard } from '@/components/MetricCard';

<MetricCard
  title="待匹配流水"
  value={127}
  unit="笔"
/>
```

**完整功能**
```tsx
<MetricCard
  title="待匹配流水"
  value={127}
  unit="笔"
  trend={{
    value: 12,           // 变化百分比
    direction: 'down',   // 'up' | 'down' | 'flat'
    period: '较上月'
  }}
  status="warning"       // 'normal' | 'warning' | 'danger'
  action={{
    label: '去处理',
    onClick: () => router.push('/matching')
  }}
  loading={false}
/>
```

**效果：**
- 悬停时上浮 4px
- warning 状态显示左侧黄色边框
- danger 状态显示左侧红色边框
- 数字使用等宽字体，36px 大字号

---

### 2. MoneyDisplay - 金额显示

**适用场景：** 所有需要显示金额的地方

**基础用法**
```tsx
import { MoneyDisplay } from '@/components/MoneyDisplay';

<MoneyDisplay value={12500.50} />
// 输出: ¥12,500.50
```

**完整功能**
```tsx
<MoneyDisplay
  value={-12500.50}
  currency="¥"           // 货币符号，默认 ¥
  colorize={true}        // 负数显示红色
  size="large"           // 'small' | 'medium' | 'large'
  showSign={true}        // 显示 +/- 符号
  className="custom"
/>
// 输出: -¥12,500.50 (红色)
```

**特性：**
- 自动千分位分隔
- 固定两位小数
- 等宽数字字体
- 右对齐显示

**在表格中使用**
```tsx
const columns = [
  {
    title: '金额',
    dataIndex: 'amount',
    align: 'right',
    render: (value: number) => (
      <MoneyDisplay value={value} colorize />
    )
  }
];
```

---

### 3. StatusBadge - 状态徽章

**适用场景：** 订单状态、付款状态、匹配状态

**基础用法**
```tsx
import { StatusBadge } from '@/components/StatusBadge';

<StatusBadge status="paid" />
<StatusBadge status="unpaid" />
<StatusBadge status="matched" />
```

**自定义文本**
```tsx
<StatusBadge status="paid" text="已全额付款" />
```

**支持的状态**
```tsx
// 付款状态
'paid'         // 已付款 - 绿色
'unpaid'       // 未付款 - 红色
'partial_paid' // 部分付款 - 黄色

// 匹配状态
'matched'      // 已匹配 - 绿色
'unmatched'    // 未匹配 - 灰色

// 账套状态
'open'         // 待做账 - 黄色
'closed'       // 已封账 - 绿色

// 审核状态
'pending'      // 待处理 - 蓝色
'confirmed'    // 已确认 - 绿色
'rejected'     // 已拒绝 - 红色
```

**在表格中使用**
```tsx
const columns = [
  {
    title: '付款状态',
    dataIndex: 'paymentStatus',
    render: (status: string) => (
      <StatusBadge status={status} />
    )
  }
];
```

---

### 4. EmptyState - 空状态

**适用场景：** 无数据、搜索无结果、加载失败

**基础用法**
```tsx
import { EmptyState } from '@/components/EmptyState';

<EmptyState
  title="暂无银行流水"
  description="导入银行流水后开始匹配"
/>
```

**完整功能**
```tsx
<EmptyState
  title="暂无银行流水"
  description="导入银行流水后，系统会自动推荐匹配的支出明细"
  icon={<InboxOutlined />}
  primaryAction={{
    label: '导入流水',
    onClick: handleImport,
    icon: <UploadOutlined />
  }}
  secondaryAction={{
    label: '查看导入说明',
    onClick: showHelp
  }}
  type="default"  // 'default' | 'search' | 'error'
/>
```

**预设类型**
```tsx
// 搜索无结果
<EmptyState type="search" />
// 自动显示: 未找到匹配的结果，尝试修改搜索条件

// 加载失败
<EmptyState type="error" />
// 自动显示: 加载失败，请检查网络连接或稍后重试
```

---

## 📋 实战示例

### 示例 1：优化首页仪表盘

**原代码**
```tsx
<Card>
  <Typography.Text type="secondary">待匹配流水</Typography.Text>
  <Typography.Title level={2}>127</Typography.Title>
</Card>
```

**优化后**
```tsx
import { MetricCard } from '@/components/MetricCard';

<MetricCard
  title="待匹配流水"
  value={127}
  unit="笔"
  status={127 > 50 ? 'warning' : 'normal'}
  action={{
    label: '去处理',
    onClick: () => router.push('/matching')
  }}
/>
```

---

### 示例 2：优化支出明细表格

**原代码**
```tsx
const columns = [
  { 
    title: '金额', 
    dataIndex: 'amount',
    render: (value) => `¥${value}` 
  },
  { 
    title: '状态', 
    dataIndex: 'status',
    render: (s) => <Tag color={s === 'paid' ? 'green' : 'red'}>{s}</Tag>
  }
];
```

**优化后**
```tsx
import { MoneyDisplay } from '@/components/MoneyDisplay';
import { StatusBadge } from '@/components/StatusBadge';

const columns = [
  { 
    title: '金额', 
    dataIndex: 'amount',
    align: 'right',
    render: (value) => <MoneyDisplay value={value} colorize />
  },
  { 
    title: '付款状态', 
    dataIndex: 'paymentStatus',
    render: (status) => <StatusBadge status={status} />
  }
];
```

---

### 示例 3：优化空数据处理

**原代码**
```tsx
<Table
  dataSource={data}
  locale={{ emptyText: '暂无数据' }}
/>
```

**优化后**
```tsx
import { EmptyState } from '@/components/EmptyState';

{data.length === 0 ? (
  <EmptyState
    title="暂无银行流水"
    description="导入银行流水后开始匹配"
    primaryAction={{
      label: '导入流水',
      onClick: handleImport,
      icon: <UploadOutlined />
    }}
    secondaryAction={{
      label: '查看导入说明',
      onClick: () => window.open('/docs/import', '_blank')
    }}
  />
) : (
  <Table dataSource={data} />
)}
```

---

## 🎯 最佳实践

### ✅ DO - 推荐做法

**1. 统一使用 MoneyDisplay 显示金额**
```tsx
// ✅ 好
<MoneyDisplay value={amount} colorize />

// ❌ 避免
<span>¥{amount.toFixed(2)}</span>
```

**2. 表格数字列右对齐**
```tsx
// ✅ 好
{
  title: '金额',
  align: 'right',
  render: (value) => <MoneyDisplay value={value} />
}

// ❌ 避免
{
  title: '金额',
  render: (value) => `¥${value}`
}
```

**3. 使用 StatusBadge 统一状态显示**
```tsx
// ✅ 好
<StatusBadge status="paid" />

// ❌ 避免
<Tag color="green">已付款</Tag>
```

**4. 空状态提供明确的操作指引**
```tsx
// ✅ 好
<EmptyState
  title="暂无数据"
  primaryAction={{ label: '创建', onClick: handleCreate }}
/>

// ❌ 避免
<Empty description="暂无数据" />
```

### ❌ DON'T - 避免做法

**1. 不要手动格式化金额**
```tsx
// ❌ 错误
<span>¥{(amount / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</span>

// ✅ 正确
<MoneyDisplay value={amount / 100} />
```

**2. 不要混用不同的状态样式**
```tsx
// ❌ 错误 - 不一致
<Tag color="green">已付款</Tag>
<Tag color="success">已确认</Tag>
<Badge status="success" text="已完成" />

// ✅ 正确 - 统一
<StatusBadge status="paid" />
<StatusBadge status="confirmed" />
<StatusBadge status="closed" />
```

**3. 不要忽略空状态**
```tsx
// ❌ 错误 - 用户不知道该做什么
{data.length === 0 && <div>暂无数据</div>}

// ✅ 正确 - 提供操作指引
{data.length === 0 && (
  <EmptyState
    title="暂无数据"
    primaryAction={{ label: '创建', onClick: handleCreate }}
  />
)}
```

---

## 🔧 组件组合模式

### 模式 1：仪表盘卡片网格

```tsx
<Flex gap={16} wrap="wrap" className="metrics">
  <MetricCard
    title="待匹配流水"
    value={metrics.unmatchedCount}
    unit="笔"
    status={metrics.unmatchedCount > 50 ? 'warning' : 'normal'}
    action={{ label: '去处理', onClick: () => router.push('/matching') }}
  />
  
  <MetricCard
    title="未分类明细"
    value={metrics.unclassifiedCount}
    unit="条"
    status={metrics.unclassifiedCount > 30 ? 'warning' : 'normal'}
    action={{ label: '去分类', onClick: () => router.push('/expenses') }}
  />
  
  <MetricCard
    title="本月收入"
    value={formatNumber(metrics.revenue)}
    unit="元"
    trend={{ value: 12.5, direction: 'up', period: '较上月' }}
  />
</Flex>
```

### 模式 2：数据表格

```tsx
<Table
  columns={[
    {
      title: '门店',
      dataIndex: 'storeName',
      fixed: 'left',
      width: 150,
    },
    {
      title: '收入',
      dataIndex: 'revenue',
      align: 'right',
      width: 120,
      render: (value) => <MoneyDisplay value={value} />,
    },
    {
      title: '支出',
      dataIndex: 'expense',
      align: 'right',
      width: 120,
      render: (value) => <MoneyDisplay value={value} />,
    },
    {
      title: '利润',
      dataIndex: 'profit',
      align: 'right',
      width: 120,
      render: (value) => <MoneyDisplay value={value} colorize />,
    },
    {
      title: '账套状态',
      dataIndex: 'status',
      width: 100,
      render: (status) => <StatusBadge status={status} />,
    },
  ]}
  dataSource={data}
/>
```

### 模式 3：条件渲染

```tsx
{loading ? (
  <Spin />
) : error ? (
  <EmptyState
    type="error"
    description={error}
    primaryAction={{ label: '重试', onClick: handleRetry }}
  />
) : data.length === 0 ? (
  <EmptyState
    title="暂无数据"
    description="创建第一条记录"
    primaryAction={{ label: '创建', onClick: handleCreate }}
  />
) : (
  <Table dataSource={data} />
)}
```

---

## 🎨 样式定制

### 自定义卡片样式

```tsx
<MetricCard
  title="自定义样式"
  value={100}
  // 通过 style 传递 CSS
/>
```

### 主题色配置

所有组件自动使用 Ant Design 主题色：
- 主色：`#2a9d66`
- 成功：`#059669`
- 警告：`#f59e0b`
- 错误：`#dc2626`

如需修改，在 `app/layout.tsx` 中调整 ConfigProvider。

---

## 📱 响应式支持

所有组件已适配响应式：

**桌面端（≥1025px）**
- 完整功能展示
- 多列布局

**平板（641-1024px）**
- 适当简化
- 双列布局

**移动端（≤640px）**
- 单列布局
- 关键信息优先

---

## 🐛 常见问题

### Q: MoneyDisplay 不显示？
A: 检查 value 是否为 number 类型，不要传字符串。

```tsx
// ❌ 错误
<MoneyDisplay value="12500" />

// ✅ 正确
<MoneyDisplay value={12500} />
<MoneyDisplay value={Number(record.amount)} />
```

### Q: StatusBadge 状态不生效？
A: 确保传入的 status 是支持的值之一。

```tsx
// 查看支持的状态列表
// components/StatusBadge.tsx 中的 statusConfig
```

### Q: 如何添加新的状态类型？
A: 编辑 `components/StatusBadge.tsx`，在 `statusConfig` 中添加。

---

## 📚 更多资源

- [设计系统文档](./design-system.md)
- [UI 优化方案](./2026-08-29-ui-ux-optimization-proposal.md)
- [实施进度](./ui-optimization-progress.md)

---

*最后更新: 2026-08-29*
