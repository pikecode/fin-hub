"use client";

import { Alert, Button, Form, Input, Modal, Space, message } from "antd";
import { useEffect, useState } from "react";
import { PlusOutlined, TeamOutlined } from "@ant-design/icons";
import type { Supplier, SupplierCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { StatusBadge } from "../components/StatusBadge";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
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
        message.success("更新成功");
      } else {
        await apiClient.suppliers.create(values);
        message.success("创建成功");
      }
      setIsModalOpen(false);
      setEditingSupplier(null);
      form.resetFields();
      await loadSuppliers();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
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
      message.success("状态更新成功");
      await loadSuppliers();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "状态更新失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleBatchDelete(ids: string[]) {
    setIsLoading(true);
    try {
      for (const id of ids) {
        await apiClient.suppliers.delete(id);
      }
      message.success(`成功删除 ${ids.length} 个供应商`);
      await loadSuppliers();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "批量删除失败");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: EnterpriseTableColumn<Supplier>[] = [
    {
      title: "供应商",
      dataIndex: "name",
      searchable: true,
    },
    {
      title: "收款账号",
      dataIndex: "bank_account",
      render: (value) => value || "-",
    },
    {
      title: "联系人",
      dataIndex: "contact_name",
      render: (value) => value || "-",
      searchable: true,
    },
    {
      title: "电话",
      dataIndex: "phone",
      render: (value) => value || "-",
    },
    {
      title: "备注",
      dataIndex: "remark",
      render: (value) => value || "-",
      ellipsis: true,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: Supplier["status"]) => (
        <StatusBadge
          status={value === "active" ? "active" : "inactive"}
          text={value === "active" ? "启用" : "停用"}
        />
      ),
    },
    {
      title: "操作",
      width: 150,
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => toggleStatus(record)}
          >
            {record.status === "active" ? "停用" : "启用"}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <AppShell
      title="供应商档案"
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
          新增供应商
        </Button>
      }
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}

      <EnterpriseTable
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={suppliers}
        exportFileName="供应商档案"
        batchActions={[
          {
            key: "delete",
            label: "批量删除",
            danger: true,
            onExecute: handleBatchDelete,
          },
        ]}
      />

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
            <Input placeholder="请输入供应商名称" />
          </Form.Item>
          <Form.Item name="bank_account" label="收款账号">
            <Input placeholder="请输入收款账号" />
          </Form.Item>
          <Form.Item name="contact_name" label="联系人">
            <Input placeholder="请输入联系人" />
          </Form.Item>
          <Form.Item name="phone" label="电话">
            <Input placeholder="请输入电话" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea placeholder="请输入备注" rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
