"use client";

import { Alert, Button, Form, Input, Modal, Space, message } from "antd";
import { useEffect, useState } from "react";
import { PlusOutlined, ShopOutlined } from "@ant-design/icons";
import type { Store, StoreCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { StatusBadge } from "../components/StatusBadge";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
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
      setErrorMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadStores();
  }, []);

  async function submitStore(values: StoreCreate) {
    setIsLoading(true);
    try {
      if (editingStore) {
        await apiClient.stores.update(editingStore.id, values);
        message.success("更新成功");
      } else {
        await apiClient.stores.create(values);
        message.success("创建成功");
      }
      setIsModalOpen(false);
      setEditingStore(null);
      form.resetFields();
      await loadStores();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
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
      message.success("状态更新成功");
      await loadStores();
    } catch (error) {
      message.error("状态更新失败");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: EnterpriseTableColumn<Store>[] = [
    {
      title: "门店名称",
      key: "name",
      dataIndex: "name",
      width: 200,
    },
    {
      title: "钉钉部门",
      key: "dingtalk_dept_id",
      dataIndex: "dingtalk_dept_id",
      width: 150,
      render: (value) => value || "-",
    },
    {
      title: "联系人",
      key: "contact_person",
      dataIndex: "contact_person",
      width: 120,
      render: (value) => value || "-",
    },
    {
      title: "电话",
      key: "phone",
      dataIndex: "phone",
      width: 140,
      render: (value) => value || "-",
    },
    {
      title: "地址",
      key: "address",
      dataIndex: "address",
      ellipsis: true,
      render: (value) => value || "-",
    },
    {
      title: "状态",
      key: "status",
      dataIndex: "status",
      width: 100,
      render: (value: Store["status"]) => (
        <StatusBadge status={value === "active" ? "active" : "inactive"} text={value === "active" ? "启用" : "停用"} />
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 150,
      fixed: "right",
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Button type="link" size="small" onClick={() => toggleStatus(record)}>
            {record.status === "active" ? "停用" : "启用"}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <AppShell
      title="门店管理"
      kicker="STORES"
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
          新增门店
        </Button>
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        {errorMessage && <Alert message="加载失败" description={errorMessage} type="error" showIcon closable />}

        <EnterpriseTable
          rowKey="id"
          columns={columns}
          dataSource={stores}
          loading={isLoading}
          exportFileName="门店列表"
        />
      </Space>

      <Modal
        title={
          <Space>
            <ShopOutlined />
            <span>{editingStore ? "编辑门店" : "新增门店"}</span>
          </Space>
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingStore(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitStore}>
          <Form.Item name="name" label="门店名称" rules={[{ required: true, message: "请输入门店名称" }]}>
            <Input placeholder="请输入门店名称" />
          </Form.Item>
          <Form.Item name="dingtalk_dept_id" label="钉钉部门 ID">
            <Input placeholder="钉钉部门 ID" />
          </Form.Item>
          <Form.Item name="contact_person" label="联系人">
            <Input placeholder="联系人姓名" />
          </Form.Item>
          <Form.Item name="phone" label="联系电话">
            <Input placeholder="联系电话" />
          </Form.Item>
          <Form.Item name="address" label="门店地址">
            <Input placeholder="门店地址" />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
