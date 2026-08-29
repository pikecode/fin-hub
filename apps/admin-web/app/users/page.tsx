"use client";

import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import type { UserAccount, UserRole } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface UserFormValues {
  username: string;
  display_name: string;
  password?: string;
  role: UserRole;
}

const roleOptions = [
  { label: "管理员", value: "admin" },
  { label: "财务", value: "finance" },
  { label: "只读", value: "viewer" },
];

export default function UsersPage() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<UserFormValues>();

  async function loadUsers() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.users.list("?page_size=200");
      setUsers(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载用户");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function openCreateModal() {
    setEditingUser(null);
    form.resetFields();
    form.setFieldsValue({ role: "finance" });
    setIsModalOpen(true);
  }

  function openEditModal(user: UserAccount) {
    setEditingUser(user);
    form.setFieldsValue({
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      password: "",
    });
    setIsModalOpen(true);
  }

  async function submitUser(values: UserFormValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (editingUser) {
        await apiClient.users.update(editingUser.id, {
          display_name: values.display_name,
          role: values.role,
          password: values.password || undefined,
        });
      } else {
        await apiClient.users.create({
          username: values.username,
          display_name: values.display_name,
          password: values.password ?? "",
          role: values.role,
        });
      }
      setIsModalOpen(false);
      setEditingUser(null);
      form.resetFields();
      await loadUsers();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存用户");
    } finally {
      setIsLoading(false);
    }
  }

  async function toggleStatus(user: UserAccount) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.users.update(user.id, {
        status: user.status === "active" ? "disabled" : "active",
      });
      await loadUsers();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法更新用户状态");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<UserAccount> = [
    { title: "账号", dataIndex: "username" },
    { title: "姓名", dataIndex: "display_name" },
    {
      title: "角色",
      dataIndex: "role",
      render: (value: UserAccount["role"]) => roleOptions.find((option) => option.value === value)?.label ?? value,
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: UserAccount["status"]) =>
        value === "active" ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
    },
    {
      title: "最后登录",
      dataIndex: "last_login_at",
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
    <AppShell
      title="用户管理"
      action={<Button type="primary" onClick={openCreateModal}>新增用户</Button>}
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="用户列表">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={users} />
      </Card>
      <Modal
        title={editingUser ? "编辑用户" : "新增用户"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingUser(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitUser}>
          <Form.Item name="username" label="账号" rules={[{ required: !editingUser }]}>
            <Input disabled={Boolean(editingUser)} />
          </Form.Item>
          <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          <Form.Item
            name="password"
            label={editingUser ? "新密码" : "密码"}
            rules={[{ required: !editingUser, min: 8 }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
