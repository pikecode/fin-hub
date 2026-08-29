"use client";

import { Alert, Button, Card, Form, Input, Modal, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import type { Supplier, SupplierCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<SupplierCreate>();

  async function loadSuppliers() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.suppliers.list("?page_size=500");
      setSuppliers(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载供应商档案");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadSuppliers();
  }, []);

  async function submitSupplier(values: SupplierCreate) {
    setIsLoading(true);
    try {
      if (editingSupplier) {
        await apiClient.suppliers.update(editingSupplier.id, values);
      } else {
        await apiClient.suppliers.create(values);
      }
      setIsModalOpen(false);
      setEditingSupplier(null);
      form.resetFields();
      await loadSuppliers();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法创建供应商");
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateModal() {
    setEditingSupplier(null);
    form.resetFields();
    setIsModalOpen(true);
  }

  function openEditModal(supplier: Supplier) {
    setEditingSupplier(supplier);
    form.setFieldsValue({
      name: supplier.name,
      bank_account: supplier.bank_account,
      contact_name: supplier.contact_name,
      phone: supplier.phone,
      remark: supplier.remark,
    });
    setIsModalOpen(true);
  }

  async function toggleStatus(supplier: Supplier) {
    setIsLoading(true);
    try {
      await apiClient.suppliers.update(supplier.id, {
        status: supplier.status === "active" ? "inactive" : "active",
      });
      await loadSuppliers();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新供应商");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<Supplier> = [
    { title: "供应商", dataIndex: "name" },
    { title: "收款账号", dataIndex: "bank_account", render: (value) => value || "-" },
    { title: "联系人", dataIndex: "contact_name", render: (value) => value || "-" },
    { title: "电话", dataIndex: "phone", render: (value) => value || "-" },
    { title: "备注", dataIndex: "remark", render: (value) => value || "-" },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: Supplier["status"]) =>
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
      title="供应商档案"
      action={<Button type="primary" onClick={openCreateModal}>新增供应商</Button>}
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="供应商列表">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={suppliers} />
      </Card>
      <Modal
        title={editingSupplier ? "编辑供应商" : "新增供应商"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingSupplier(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitSupplier}>
          <Form.Item name="name" label="供应商名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="bank_account" label="收款账号">
            <Input />
          </Form.Item>
          <Form.Item name="contact_name" label="联系人">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="电话">
            <Input />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
