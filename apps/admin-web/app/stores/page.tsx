"use client";

import { Alert, Button, Card, Form, Input, Modal, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import type { Store, StoreCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<StoreCreate>();

  async function loadStores() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.stores.list("?page_size=200");
      setStores(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载门店");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadStores();
  }, []);

  async function submitStore(values: StoreCreate) {
    setIsLoading(true);
    try {
      if (editingStore) {
        await apiClient.stores.update(editingStore.id, values);
      } else {
        await apiClient.stores.create(values);
      }
      setIsModalOpen(false);
      setEditingStore(null);
      form.resetFields();
      await loadStores();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法创建门店");
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateModal() {
    setEditingStore(null);
    form.resetFields();
    setIsModalOpen(true);
  }

  function openEditModal(store: Store) {
    setEditingStore(store);
    form.setFieldsValue({
      name: store.name,
      dingtalk_dept_id: store.dingtalk_dept_id,
      contact_person: store.contact_person,
      phone: store.phone,
      address: store.address,
    });
    setIsModalOpen(true);
  }

  async function toggleStatus(store: Store) {
    setIsLoading(true);
    try {
      await apiClient.stores.update(store.id, {
        status: store.status === "active" ? "inactive" : "active",
      });
      await loadStores();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新门店");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<Store> = [
    { title: "门店", dataIndex: "name" },
    { title: "钉钉部门", dataIndex: "dingtalk_dept_id", render: (value) => value || "-" },
    { title: "联系人", dataIndex: "contact_person", render: (value) => value || "-" },
    { title: "电话", dataIndex: "phone", render: (value) => value || "-" },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: Store["status"]) =>
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
      title="门店管理"
      action={<Button type="primary" onClick={openCreateModal}>新增门店</Button>}
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="门店列表">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={stores} />
      </Card>
      <Modal
        title={editingStore ? "编辑门店" : "新增门店"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingStore(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitStore}>
          <Form.Item name="name" label="门店名称" rules={[{ required: true }]}>
            <Input placeholder="请输入门店名称" />
          </Form.Item>
          <Form.Item name="dingtalk_dept_id" label="钉钉部门 ID">
            <Input />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="contact_person" label="联系人" className="compact-form-item">
              <Input />
            </Form.Item>
            <Form.Item name="phone" label="电话" className="compact-form-item">
              <Input />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="address" label="地址">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
