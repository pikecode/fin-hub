"use client";

import { Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import type { ExpenseCategory, ExpenseCategoryCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

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

  const columns: ColumnsType<ExpenseCategory> = [
    { title: "分类名称", dataIndex: "name" },
    {
      title: "上级分类",
      dataIndex: "parent_id",
      render: (value) => (value ? categoryById.get(value)?.name ?? value : <Tag color="blue">一级分类</Tag>),
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
      action={<Button type="primary" onClick={openCreateModal}>新增分类</Button>}
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="分类列表">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={categories} />
      </Card>
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
