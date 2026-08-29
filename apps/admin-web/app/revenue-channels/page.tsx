"use client";

import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import type { RevenueChannel, RevenueChannelCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

export default function RevenueChannelsPage() {
  const [channels, setChannels] = useState<RevenueChannel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<RevenueChannel | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<RevenueChannelCreate>();

  async function loadChannels() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.revenueChannels.list("?page_size=500");
      setChannels(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载收入渠道");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadChannels();
  }, []);

  async function submitChannel(values: RevenueChannelCreate) {
    setIsLoading(true);
    try {
      const payload = {
        ...values,
        sort_order: values.sort_order ?? 0,
        requires_bank_match: values.requires_bank_match ?? true,
      };
      if (editingChannel) {
        await apiClient.revenueChannels.update(editingChannel.id, payload);
      } else {
        await apiClient.revenueChannels.create(payload);
      }
      setIsModalOpen(false);
      setEditingChannel(null);
      form.resetFields();
      await loadChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存收入渠道");
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateModal() {
    setEditingChannel(null);
    form.resetFields();
    form.setFieldsValue({ sort_order: 0, requires_bank_match: true });
    setIsModalOpen(true);
  }

  function openEditModal(channel: RevenueChannel) {
    setEditingChannel(channel);
    form.setFieldsValue({
      name: channel.name,
      sort_order: channel.sort_order,
      requires_bank_match: channel.requires_bank_match,
    });
    setIsModalOpen(true);
  }

  async function toggleStatus(channel: RevenueChannel) {
    setIsLoading(true);
    try {
      await apiClient.revenueChannels.update(channel.id, {
        status: channel.status === "active" ? "inactive" : "active",
      });
      await loadChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新收入渠道");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<RevenueChannel> = [
    { title: "渠道名称", dataIndex: "name" },
    { title: "排序", dataIndex: "sort_order", width: 100 },
    {
      title: "需匹配流水",
      dataIndex: "requires_bank_match",
      width: 130,
      render: (value: boolean) => (value ? <Tag color="blue">需要</Tag> : <Tag>不需要</Tag>),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: RevenueChannel["status"]) =>
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
    <AppShell title="收入渠道" action={<Button type="primary" onClick={openCreateModal}>新增渠道</Button>}>
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="渠道列表">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={channels} />
      </Card>
      <Modal
        title={editingChannel ? "编辑渠道" : "新增渠道"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingChannel(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={submitChannel}
          initialValues={{ sort_order: 0, requires_bank_match: true }}
        >
          <Form.Item name="name" label="渠道名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <InputNumber className="full-width" />
          </Form.Item>
          <Form.Item name="requires_bank_match" label="需匹配银行流水" valuePropName="checked">
            <Switch checkedChildren="需要" unCheckedChildren="不需要" />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
