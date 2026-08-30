"use client";

import { Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import type { ExpenseCategory, ExpenseCategoryCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface CategoryTreeNode extends ExpenseCategory {
  children?: CategoryTreeNode[];
}

export default function CategoriesPage() {
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ExpenseCategory | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<ExpenseCategoryCreate>();

  const parentOptions = useMemo(
    () =>
      categories
        .filter((category) => !category.parent_id)
        .map((category) => ({ label: category.name, value: category.id })),
    [categories],
  );
  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  const treeData = useMemo<CategoryTreeNode[]>(() => {
    const nodeMap = new Map(categories.map((category) => [category.id, { ...category } as CategoryTreeNode]));
    const roots: CategoryTreeNode[] = [];
    categories.forEach((category) => {
      const node = nodeMap.get(category.id);
      if (!node) return;
      if (category.parent_id && nodeMap.has(category.parent_id)) {
        const parent = nodeMap.get(category.parent_id);
        parent!.children = parent!.children ?? [];
        parent!.children.push(node);
      } else {
        roots.push(node);
      }
    });
    const sortNodes = (nodes: CategoryTreeNode[]) => {
      nodes.sort((left, right) => left.sort_order - right.sort_order || left.created_at.localeCompare(right.created_at));
      nodes.forEach((node) => {
        if (node.children?.length) sortNodes(node.children);
      });
    };
    sortNodes(roots);
    return roots;
  }, [categories]);
  const expandedRowKeys = useMemo(() => treeData.map((category) => category.id), [treeData]);
  const firstLevelCount = categories.filter((category) => !category.parent_id).length;
  const secondLevelCount = categories.length - firstLevelCount;
  const activeCount = categories.filter((category) => category.status === "active").length;

  async function loadCategories() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.categories.list("?page_size=500");
      setCategories(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载费用分类");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadCategories();
  }, []);

  async function submitCategory(values: ExpenseCategoryCreate) {
    setIsLoading(true);
    try {
      if (editingCategory) {
        await apiClient.categories.update(editingCategory.id, values);
      } else {
        await apiClient.categories.create(values);
      }
      setIsModalOpen(false);
      setEditingCategory(null);
      form.resetFields();
      await loadCategories();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法创建费用分类");
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateModal() {
    setEditingCategory(null);
    form.resetFields();
    form.setFieldsValue({ sort_order: 0 });
    setIsModalOpen(true);
  }

  function openCreateChildModal(parent: ExpenseCategory) {
    setEditingCategory(null);
    form.resetFields();
    form.setFieldsValue({ parent_id: parent.id, sort_order: 0 });
    setIsModalOpen(true);
  }

  function openEditModal(category: ExpenseCategory) {
    setEditingCategory(category);
    form.setFieldsValue({
      name: category.name,
      parent_id: category.parent_id,
      sort_order: category.sort_order,
    });
    setIsModalOpen(true);
  }

  async function toggleStatus(category: ExpenseCategory) {
    setIsLoading(true);
    try {
      await apiClient.categories.update(category.id, {
        status: category.status === "active" ? "inactive" : "active",
      });
      await loadCategories();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新费用分类");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<CategoryTreeNode> = [
    {
      title: "分类名称",
      dataIndex: "name",
      render: (value, record) => (
        <Space size={8}>
          <Typography.Text strong={!record.parent_id}>{value}</Typography.Text>
          {record.parent_id ? <Tag>二级分类</Tag> : <Tag color="blue">一级分类</Tag>}
        </Space>
      ),
    },
    {
      title: "上级分类",
      dataIndex: "parent_id",
      width: 180,
      render: (value) => (value ? categoryById.get(value)?.name ?? value : <Tag color="blue">一级分类</Tag>),
    },
    {
      title: "子分类",
      width: 100,
      align: "right",
      render: (_, record) => (record.parent_id ? "-" : record.children?.length ?? 0),
    },
    { title: "排序", dataIndex: "sort_order", width: 100 },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: ExpenseCategory["status"]) =>
        value === "active" ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
    },
    {
      title: "操作",
      width: 150,
      render: (_, record) => (
        <Space>
          {!record.parent_id ? <Button type="link" onClick={() => openCreateChildModal(record)}>新增子分类</Button> : null}
          <Button type="link" onClick={() => openEditModal(record)}>编辑</Button>
          <Button type="link" onClick={() => toggleStatus(record)}>
            {record.status === "active" ? "停用" : "启用"}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <AppShell
      title="费用分类"
      kicker="维护支出归类口径，用于对账和报表分析"
      action={<Button type="primary" onClick={openCreateModal}>新增一级分类</Button>}
    >
      <div className="category-tree-page">
        {errorMessage ? (
          <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
        ) : null}
        <Card className="dashboard-alert">
          <Space wrap size={24}>
            <Statistic title="一级分类" value={firstLevelCount} />
            <Statistic title="二级分类" value={secondLevelCount} />
            <Statistic title="启用分类" value={activeCount} />
          </Space>
        </Card>
        <Card title="分类树" className="data-table-card">
          <Table
            rowKey="id"
            loading={isLoading}
            columns={columns}
            dataSource={treeData}
            expandable={{ defaultExpandedRowKeys: expandedRowKeys }}
            pagination={false}
            scroll={{ x: 860 }}
          />
        </Card>
      </div>
      <Modal
        title={editingCategory ? "编辑分类" : "新增分类"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingCategory(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitCategory} initialValues={{ sort_order: 0 }}>
          <Form.Item name="name" label="分类名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="parent_id" label="上级分类">
            <Select allowClear options={parentOptions} />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <InputNumber className="full-width" />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
