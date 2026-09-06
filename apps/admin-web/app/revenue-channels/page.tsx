"use client";

import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Tag, message } from "antd";
import { useEffect, useState } from "react";
import { DeleteOutlined, PlusOutlined, MoneyCollectOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import type { RevenueChannel, RevenueChannelCreate, Store } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { StatusBadge } from "../components/StatusBadge";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
import { apiClient } from "../lib/api";
import { useClientSearchParams } from "../lib/searchParams";

export default function RevenueChannelsPage() {
  const router = useRouter();
  const searchParams = useClientSearchParams();
  const returnTo = searchParams.get("return_to");
  const [channels, setChannels] = useState<RevenueChannel[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<RevenueChannel | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<RevenueChannelCreate>();

  async function loadChannels() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [page, storePage] = await Promise.all([
        apiClient.revenueChannels.list("?page_size=500"),
        apiClient.stores.list("?page_size=500"),
      ]);
      setChannels(page.items);
      setStores(storePage.items);
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
        scope_mode: values.scope_mode ?? "all_stores",
        store_ids:
          values.scope_mode === "selected_stores"
            ? values.store_ids?.length
              ? values.store_ids
              : []
            : [],
      };
      if (editingChannel) {
        await apiClient.revenueChannels.update(editingChannel.id, payload);
        message.success("更新成功");
      } else {
        const created = await apiClient.revenueChannels.create(payload);
        message.success("创建成功");
        if (returnTo) {
          const target = new URL(returnTo, window.location.origin);
          target.searchParams.set("channel", created.name);
          router.push(`${target.pathname}${target.search}`);
          return;
        }
      }
      setIsModalOpen(false);
      setEditingChannel(null);
      form.resetFields();
      await loadChannels();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateModal() {
    setEditingChannel(null);
    form.resetFields();
    form.setFieldsValue({ sort_order: 0, requires_bank_match: true, scope_mode: "all_stores", store_ids: [] });
    setIsModalOpen(true);
  }

  function openEditModal(channel: RevenueChannel) {
    setEditingChannel(channel);
    form.setFieldsValue({
      name: channel.name,
      sort_order: channel.sort_order,
      requires_bank_match: channel.requires_bank_match,
      scope_mode: channel.scope_mode,
      store_ids: channel.store_ids ?? [],
    });
    setIsModalOpen(true);
  }

  async function toggleStatus(channel: RevenueChannel) {
    setIsLoading(true);
    try {
      await apiClient.revenueChannels.update(channel.id, {
        status: channel.status === "active" ? "inactive" : "active",
      });
      message.success("状态更新成功");
      await loadChannels();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "状态更新失败");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: EnterpriseTableColumn<RevenueChannel>[] = [
    {
      key: "name",
      title: "渠道名称",
      dataIndex: "name",
    },
    {
      key: "sort_order",
      title: "排序",
      dataIndex: "sort_order",
      width: 100,
      sorter: (a, b) => a.sort_order - b.sort_order,
    },
    {
      key: "requires_bank_match",
      title: "需匹配流水",
      dataIndex: "requires_bank_match",
      width: 130,
      render: (value: boolean) => (
        <StatusBadge
          status={value ? "info" : "default"}
          text={value ? "需要" : "不需要"}
        />
      ),
    },
    {
      key: "scope_mode",
      title: "适用范围",
      width: 180,
      render: (_, record) =>
        record.scope_mode === "all_stores" ? (
          <Tag>全部门店</Tag>
        ) : (
          <Tag color="blue">指定门店 {record.store_ids?.length ? `(${record.store_ids.length})` : ""}</Tag>
        ),
    },
    {
      key: "status",
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (value: RevenueChannel["status"]) => (
        <StatusBadge
          status={value === "active" ? "active" : "inactive"}
          text={value === "active" ? "启用" : "停用"}
        />
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 220,
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
          <Popconfirm
            title="确认删除该渠道？"
            description="删除后不会影响历史记录。"
            onConfirm={async () => {
              setIsLoading(true);
              try {
                await apiClient.revenueChannels.delete(record.id);
                message.success("删除成功");
                await loadChannels();
              } catch (error) {
                message.error(error instanceof Error ? error.message : "删除失败");
              } finally {
                setIsLoading(false);
              }
            }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <AppShell
      title="收入渠道"
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
          新增渠道
        </Button>
      }
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}

      <div className="table-toolbar">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            新增渠道
          </Button>
        </Space>
      </div>

      <EnterpriseTable
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={channels}
        exportFileName="收入渠道"
      />

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
          <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请输入渠道名称" }]}>
            <Input placeholder="如：线上订单、现金收款" />
          </Form.Item>
          <Form.Item name="sort_order" label="排序" tooltip="数字越小越靠前">
            <InputNumber className="full-width" min={0} placeholder="0" />
          </Form.Item>
          <Form.Item name="scope_mode" label="适用范围" initialValue="all_stores">
            <Select
              options={[
                { label: "全部门店", value: "all_stores" },
                { label: "指定门店", value: "selected_stores" },
              ]}
              onChange={(value) => {
                if (value === "all_stores") {
                  form.setFieldValue("store_ids", []);
                }
              }}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.scope_mode !== next.scope_mode}>
            {({ getFieldValue }) =>
              getFieldValue("scope_mode") === "selected_stores" ? (
                <Form.Item name="store_ids" label="适用门店" rules={[{ required: true, message: "请选择适用门店" }]}>
                  <Select mode="multiple" options={stores.map((store) => ({ label: store.name, value: store.id }))} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item
            name="requires_bank_match"
            label="需匹配银行流水"
            valuePropName="checked"
            tooltip="如果选择需要，该渠道的收入需要与银行流水匹配"
          >
            <Switch checkedChildren="需要" unCheckedChildren="不需要" />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
