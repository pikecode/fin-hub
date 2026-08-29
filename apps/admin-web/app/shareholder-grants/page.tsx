"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type { ShareholderAccessGrant, Store } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface GrantFormValues {
  name: string;
  access_code?: string;
  store_ids: string[];
  expires_at?: dayjs.Dayjs | null;
}

export default function ShareholderGrantsPage() {
  const [grants, setGrants] = useState<ShareholderAccessGrant[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingGrant, setEditingGrant] = useState<ShareholderAccessGrant | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<GrantFormValues>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const storeOptions = stores.map((store) => ({ label: store.name, value: store.id }));

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [grantPage, storePage] = await Promise.all([
        apiClient.shareholderGrants.list("?page_size=200"),
        apiClient.stores.list("?page_size=200"),
      ]);
      setGrants(grantPage.items);
      setStores(storePage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载股东授权");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  function openCreateModal() {
    setEditingGrant(null);
    form.resetFields();
    setIsModalOpen(true);
  }

  function openEditModal(grant: ShareholderAccessGrant) {
    setEditingGrant(grant);
    form.setFieldsValue({
      name: grant.name,
      access_code: "",
      store_ids: grant.store_ids,
      expires_at: grant.expires_at ? dayjs(grant.expires_at) : null,
    });
    setIsModalOpen(true);
  }

  async function submitGrant(values: GrantFormValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (editingGrant) {
        await apiClient.shareholderGrants.update(editingGrant.id, {
          name: values.name,
          access_code: values.access_code || undefined,
          store_ids: values.store_ids,
          expires_at: values.expires_at ? values.expires_at.endOf("day").format("YYYY-MM-DDTHH:mm:ss") : null,
        });
      } else {
        await apiClient.shareholderGrants.create({
          name: values.name,
          access_code: values.access_code ?? "",
          store_ids: values.store_ids,
          expires_at: values.expires_at ? values.expires_at.endOf("day").format("YYYY-MM-DDTHH:mm:ss") : null,
        });
      }
      setIsModalOpen(false);
      setEditingGrant(null);
      form.resetFields();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存股东授权");
    } finally {
      setIsLoading(false);
    }
  }

  async function toggleStatus(grant: ShareholderAccessGrant) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.shareholderGrants.update(grant.id, {
        status: grant.status === "active" ? "disabled" : "active",
      });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新授权状态");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<ShareholderAccessGrant> = [
    { title: "授权名称", dataIndex: "name" },
    {
      title: "授权门店",
      dataIndex: "store_ids",
      render: (value: string[]) =>
        value.length ? value.map((storeId) => storesById.get(storeId)?.name ?? storeId).join("、") : "-",
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: ShareholderAccessGrant["status"], record) => {
        if (record.expires_at && dayjs(record.expires_at).isBefore(dayjs())) {
          return <Tag color="red">已过期</Tag>;
        }
        return value === "active" ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>;
      },
    },
    {
      title: "到期时间",
      dataIndex: "expires_at",
      width: 170,
      render: (value: string | null) => (value ? value.replace("T", " ").slice(0, 16) : "长期有效"),
    },
    {
      title: "最后使用",
      dataIndex: "last_login_at",
      width: 170,
      render: (value: string | null) => (value ? value.replace("T", " ").slice(0, 16) : "-"),
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
    <AppShell title="股东授权" action={<Button type="primary" onClick={openCreateModal}>新增授权</Button>}>
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="授权列表">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={grants} />
      </Card>
      <Modal
        title={editingGrant ? "编辑授权" : "新增授权"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingGrant(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitGrant}>
          <Form.Item name="name" label="授权名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="access_code"
            label={editingGrant ? "新授权码" : "授权码"}
            rules={[{ required: !editingGrant, min: 6 }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="store_ids" label="授权门店" rules={[{ required: true }]}>
            <Select mode="multiple" options={storeOptions} />
          </Form.Item>
          <Form.Item name="expires_at" label="到期日期">
            <DatePicker className="full-width" allowClear />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
