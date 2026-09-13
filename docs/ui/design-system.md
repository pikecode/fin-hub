# fin-hub 设计系统

## 概述

fin-hub 设计系统基于 Ant Design 5.x，针对财务管理系统的特殊需求进行了定制和扩展。

## 设计原则

### 1. 效率优先
财务工作追求准确和高效，界面设计应减少操作步数，提供快捷路径。

### 2. 数据为王
数字、状态、趋势是核心，视觉设计应强化数据可读性。

### 3. 防错优先
财务数据不容出错，界面应提供充分的确认机制和校验提示。

### 4. 渐进增强
基础功能简单直接，高级功能逐步展现，避免认知负担。

## 色彩系统

### 主色调

```css
/* 主色 - 专业可信的绿色 */
--color-primary: #2a9d66;
--color-primary-hover: #248f5c;
--color-primary-active: #1d7d51;
--color-primary-light: #dcf2e4;
```

### 功能色

```css
/* 成功 */
--color-success: #059669;

/* 警告 */
--color-warning: #f59e0b;

/* 错误 */
--color-error: #dc2626;

/* 信息 */
--color-info: #0ea5e9;
```

### 中性色

```css
--color-gray-50: #f9fafb;
--color-gray-100: #f3f4f6;
--color-gray-200: #e5e7eb;
--color-gray-300: #d1d5db;
--color-gray-400: #9ca3af;
--color-gray-500: #6b7280;
--color-gray-600: #4b5563;
--color-gray-700: #374151;
--color-gray-800: #1f2937;
--color-gray-900: #111827;
```

### 背景色

```css
--bg-base: #ffffff;          /* 纯白 */
--bg-layout: #f9fafb;        /* 浅灰 */
--bg-elevated: #ffffff;      /* 卡片/弹窗 */
--bg-sidebar: #0f172a;       /* 侧边栏 */
```

## 字体排版

### 字体家族

```css
font-family: -apple-system, BlinkMacSystemFont, 
  "Segoe UI", "PingFang SC", "Hiragino Sans GB", 
  "Microsoft YaHei", sans-serif;
```

### 等宽数字字体（用于金额）

```css
font-family: -apple-system, BlinkMacSystemFont, 
  'SF Mono', 'Consolas', 'Monaco', monospace;
font-variant-numeric: tabular-nums;
font-feature-settings: 'tnum';
```

### 字号层级

```css
--font-size-xs: 12px;
--font-size-sm: 13px;
--font-size-base: 14px;
--font-size-lg: 16px;
--font-size-xl: 20px;
--font-size-2xl: 24px;
--font-size-3xl: 28px;
--font-size-4xl: 36px;
```

### 字重

```css
--font-weight-normal: 400;
--font-weight-medium: 500;
--font-weight-semibold: 600;
--font-weight-bold: 700;
```

## 间距系统

采用 4px 基础单位：

```css
--spacing-1: 4px;
--spacing-2: 8px;
--spacing-3: 12px;
--spacing-4: 16px;
--spacing-5: 20px;
--spacing-6: 24px;
--spacing-8: 32px;
--spacing-10: 40px;
--spacing-12: 48px;
--spacing-16: 64px;
```

## 圆角

```css
--radius-sm: 4px;
--radius-base: 6px;
--radius-md: 8px;
--radius-lg: 12px;
--radius-xl: 16px;
--radius-full: 9999px;
```

## 阴影

```css
/* 小 - 用于按钮、输入框 */
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);

/* 中 - 用于卡片 */
--shadow-md: 0 1px 3px rgba(0, 0, 0, 0.06), 
             0 1px 2px rgba(0, 0, 0, 0.04);

/* 大 - 用于弹窗、下拉 */
--shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.12);

/* 超大 - 用于模态框 */
--shadow-xl: 0 20px 60px rgba(0, 0, 0, 0.15);
```

## 组件使用指南

### MetricCard - 指标卡片

用于仪表盘显示关键指标。

```tsx
import { MetricCard } from '@/components/MetricCard';

<MetricCard
  title="待匹配流水"
  value={127}
  unit="笔"
  trend={{
    value: 12,
    direction: 'down',
    period: '较上月'
  }}
  status="warning"
  action={{
    label: '去处理',
    onClick: () => router.push('/matching')
  }}
/>
```

**Props:**
- `title` - 指标名称
- `value` - 指标值
- `unit` - 单位（可选）
- `trend` - 趋势对比（可选）
  - `value` - 变化百分比
  - `direction` - 'up' | 'down' | 'flat'
  - `period` - 对比周期
- `status` - 'normal' | 'warning' | 'danger'
- `action` - 快捷操作（可选）
- `loading` - 加载状态

### MoneyDisplay - 金额显示

用于统一的金额格式化显示。

```tsx
import { MoneyDisplay } from '@/components/MoneyDisplay';

<MoneyDisplay value={12500.50} colorize showSign />
```

**Props:**
- `value` - 金额数值（必需）
- `currency` - 货币符号，默认 '¥'
- `colorize` - 是否着色（负数红色）
- `size` - 'small' | 'medium' | 'large'
- `showSign` - 是否显示正负号

**特性:**
- 自动千分位分隔
- 保留两位小数
- 等宽数字字体
- 右对齐显示

### StatusBadge - 状态徽章

用于显示业务状态。

```tsx
import { StatusBadge } from '@/components/StatusBadge';

<StatusBadge status="paid" />
<StatusBadge status="unpaid" text="自定义文本" />
```

**支持的状态:**
- `paid` - 已付款（绿色）
- `unpaid` - 未付款（红色）
- `partial_paid` - 部分付款（黄色）
- `matched` - 已匹配（绿色）
- `unmatched` - 未匹配（灰色）
- `open` - 待做账（黄色）
- `closed` - 已封账（绿色）
- `pending` - 待处理（蓝色）
- `confirmed` - 已确认（绿色）
- `rejected` - 已拒绝（红色）

### EmptyState - 空状态

用于无数据、搜索无结果、错误等场景。

```tsx
import { EmptyState } from '@/components/EmptyState';

<EmptyState
  title="暂无银行流水"
  description="导入银行流水后，系统会自动推荐匹配的支出明细"
  primaryAction={{
    label: '导入流水',
    onClick: handleImport,
    icon: <UploadOutlined />
  }}
  secondaryAction={{
    label: '查看导入说明',
    onClick: showHelp
  }}
/>
```

**Props:**
- `title` - 标题
- `description` - 描述文本
- `icon` - 自定义图标
- `primaryAction` - 主要操作
- `secondaryAction` - 次要操作
- `type` - 'default' | 'search' | 'error'

## 表格设计规范

### 金额列

```tsx
{
  title: '金额',
  dataIndex: 'amount',
  align: 'right',
  render: (value: number) => (
    <MoneyDisplay value={value} colorize />
  )
}
```

### 状态列

```tsx
{
  title: '付款状态',
  dataIndex: 'paymentStatus',
  render: (status: string) => (
    <StatusBadge status={status} />
  )
}
```

### 日期列

```tsx
{
  title: '交易日期',
  dataIndex: 'transactionDate',
  render: (date: string) => dayjs(date).format('YYYY-MM-DD')
}
```

### 操作列

```tsx
{
  title: '操作',
  fixed: 'right',
  width: 120,
  render: (record) => (
    <Space size="small">
      <Button type="link" size="small">编辑</Button>
      <Button type="link" size="small" danger>删除</Button>
    </Space>
  )
}
```

## 表单设计规范

### 表单布局

```tsx
<Form
  layout="vertical"
  labelCol={{ span: 24 }}
  wrapperCol={{ span: 24 }}
>
  <Form.Item
    label="门店"
    name="storeId"
    rules={[{ required: true, message: '请选择门店' }]}
  >
    <Select placeholder="请选择门店" />
  </Form.Item>
</Form>
```

### 金额输入

```tsx
<Form.Item
  label="金额"
  name="amount"
  rules={[
    { required: true, message: '请输入金额' },
    { 
      pattern: /^\d+(\.\d{1,2})?$/, 
      message: '请输入有效的金额，最多两位小数' 
    }
  ]}
>
  <Input 
    prefix="¥" 
    placeholder="0.00"
    style={{ width: 200 }}
  />
</Form.Item>
```

## 响应式断点

```css
/* 移动端 */
@media (max-width: 640px) {
  /* 单列布局、底部导航、简化表格 */
}

/* 平板 */
@media (min-width: 641px) and (max-width: 1024px) {
  /* 双列布局、侧边栏折叠 */
}

/* 桌面端 */
@media (min-width: 1025px) {
  /* 多列布局、展开所有面板 */
}

/* 大屏 */
@media (min-width: 1920px) {
  /* 最大化内容区、显示更多信息 */
}
```

## 动画时长

```css
--duration-fast: 0.15s;
--duration-base: 0.3s;
--duration-slow: 0.5s;
```

## 最佳实践

### 1. 金额显示

✅ **正确**
```tsx
<MoneyDisplay value={12500.50} colorize />
// 输出: ¥12,500.50（等宽数字，右对齐）
```

❌ **错误**
```tsx
<span>¥{amount}</span>
// 问题：无千分位、无固定小数位、对齐混乱
```

### 2. 状态显示

✅ **正确**
```tsx
<StatusBadge status="paid" />
// 统一的颜色和样式
```

❌ **错误**
```tsx
<Tag color={status === 'paid' ? 'green' : 'red'}>
  {status === 'paid' ? '已付款' : '未付款'}
</Tag>
// 问题：颜色不统一、文案散落各处
```

### 3. 空状态

✅ **正确**
```tsx
<EmptyState
  title="暂无数据"
  primaryAction={{ label: '创建', onClick: handleCreate }}
/>
// 提供明确的下一步操作
```

❌ **错误**
```tsx
<Empty description="暂无数据" />
// 问题：用户不知道该做什么
```

### 4. 表格数字列

✅ **正确**
```tsx
{
  align: 'right',
  render: (value) => <MoneyDisplay value={value} />
}
// 右对齐、等宽数字
```

❌ **错误**
```tsx
{
  render: (value) => `¥${value}`
}
// 问题：左对齐、不易对比
```

## 开发工具

### VS Code 扩展推荐

- **Tailwind CSS IntelliSense** - CSS 类名提示
- **ES7+ React/Redux/React-Native snippets** - React 代码片段
- **Prettier** - 代码格式化

### Chrome 扩展推荐

- **React Developer Tools** - React 调试
- **Redux DevTools** - 状态调试

## 参考资源

- [Ant Design 官方文档](https://ant.design/)
- [Tailwind CSS 文档](https://tailwindcss.com/)
- [Material Design 色彩系统](https://material.io/design/color)

---

*本文档持续更新中*  
*最后更新: 2026-08-29*
