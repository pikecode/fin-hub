"use client";

import { Alert, Button, Card, Checkbox, Form, Input, Modal, Select, Space, Table, Tabs, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import type { PermissionKey, Store, UserAccount, UserRole } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

type CheckboxValue = string | number | boolean;

interface UserFormValues {
  username: string;
  display_name: string;
  password?: string;
  role: UserRole;
  permissions: PermissionKey[];
  store_ids: string[];
}

const roleOptions = [
  { label: "管理员", value: "admin" },
  { label: "财务", value: "finance" },
  { label: "只读", value: "viewer" },
];

const permissionGroups: { title: string; options: { label: string; value: PermissionKey }[] }[] = [
  {
    title: "工作台",
    options: [{ label: "查看工作台", value: "dashboard.view" }],
  },
  {
    title: "财务对账",
    options: [
      { label: "查看对账", value: "reconciliation.view" },
      { label: "维护对账", value: "reconciliation.manage" },
      { label: "查看报表", value: "reports.view" },
      { label: "查看收入", value: "revenue.view" },
      { label: "维护收入", value: "revenue.manage" },
    ],
  },
  {
    title: "钉钉同步",
    options: [
      { label: "查看钉钉数据", value: "dingtalk.view" },
      { label: "维护同步配置", value: "dingtalk.manage" },
    ],
  },
  {
    title: "基础资料",
    options: [
      { label: "查看门店", value: "stores.view" },
      { label: "维护门店", value: "stores.manage" },
      { label: "查看分类", value: "categories.view" },
      { label: "维护分类", value: "categories.manage" },
    ],
  },
  {
    title: "系统管理",
    options: [
      { label: "查看用户", value: "users.view" },
      { label: "维护用户", value: "users.manage" },
      { label: "查看审计", value: "audit.view" },
      { label: "系统设置", value: "settings.manage" },
    ],
  },
];

const roleDefaultPermissions: Record<UserRole, PermissionKey[]> = {
  admin: permissionGroups.flatMap((group) => group.options.map((option) => option.value)),
  finance: [
    "dashboard.view",
    "reconciliation.view",
    "reconciliation.manage",
    "reports.view",
    "revenue.view",
    "revenue.manage",
    "stores.view",
    "stores.manage",
    "categories.view",
    "categories.manage",
    "dingtalk.view",
    "audit.view",
  ],
  viewer: ["dashboard.view", "reconciliation.view", "reports.view", "revenue.view", "stores.view", "categories.view"],
};

const impliedPermissions: Partial<Record<PermissionKey, PermissionKey[]>> = {
  "reconciliation.view": ["stores.view", "categories.view", "dingtalk.view"],
  "reconciliation.manage": ["reconciliation.view"],
  "dingtalk.manage": ["dingtalk.view"],
  "revenue.manage": ["revenue.view", "stores.view"],
  "stores.manage": ["stores.view"],
  "categories.manage": ["categories.view"],
  "users.manage": ["users.view"],
};

const dependentPermissions: Partial<Record<PermissionKey, PermissionKey[]>> = Object.entries(
  impliedPermissions,
).reduce<Partial<Record<PermissionKey, PermissionKey[]>>>((result, [permission, implied]) => {
  implied.forEach((viewPermission) => {
    result[viewPermission] = [...(result[viewPermission] ?? []), permission as PermissionKey];
  });
  return result;
}, {});

function normalizePermissions(permissions: Iterable<PermissionKey>) {
  const normalized = new Set(permissions);
  Array.from(normalized).forEach((permission) => {
    impliedPermissions[permission]?.forEach((implied) => normalized.add(implied));
  });
  return Array.from(normalized);
}

function PermissionMatrix({
  value = [],
  onChange,
}: {
  value?: PermissionKey[];
  onChange?: (permissions: PermissionKey[]) => void;
}) {
  function updateGroup(groupOptions: { value: PermissionKey }[], checkedValues: CheckboxValue[]) {
    const next = new Set(value);
    groupOptions.forEach((option) => next.delete(option.value));
    checkedValues.forEach((checkedValue) => next.add(checkedValue as PermissionKey));
    groupOptions.forEach((option) => {
      if (!next.has(option.value)) {
        dependentPermissions[option.value]?.forEach((dependent) => next.delete(dependent));
      }
    });
    onChange?.(normalizePermissions(next));
  }

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {permissionGroups.map((group) => (
        <Card key={group.title} size="small" title={group.title}>
          <Checkbox.Group
            value={value.filter((permission) =>
              group.options.some((option) => option.value === permission),
            )}
            options={group.options}
            onChange={(checkedValues) => updateGroup(group.options, checkedValues)}
          />
        </Card>
      ))}
    </Space>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
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

  async function loadStores() {
    try {
      const page = await apiClient.stores.list("?page_size=500");
      setStores(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载门店");
    }
  }

  useEffect(() => {
    loadUsers();
    loadStores();
  }, []);

  function openCreateModal() {
    setEditingUser(null);
    form.resetFields();
    form.setFieldsValue({
      role: "finance",
      permissions: roleDefaultPermissions.finance,
      store_ids: [],
    });
    setIsModalOpen(true);
  }

  function openEditModal(user: UserAccount) {
    setEditingUser(user);
    form.setFieldsValue({
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      password: "",
      permissions: user.permissions,
      store_ids: user.store_ids,
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
          permissions: values.permissions,
          store_ids: values.store_ids,
        });
      } else {
        await apiClient.users.create({
          username: values.username,
          display_name: values.display_name,
          password: values.password ?? "",
          role: values.role,
          permissions: values.permissions,
          store_ids: values.store_ids,
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
      title: "功能权限",
      dataIndex: "permissions",
      width: 120,
      render: (value: PermissionKey[]) => <Tag color="blue">{value.length} 项</Tag>,
    },
    {
      title: "门店范围",
      dataIndex: "store_ids",
      width: 140,
      render: (value: string[], record) =>
        record.role === "admin" ? <Tag color="green">全部门店</Tag> : <Tag>{value.length} 家门店</Tag>,
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
        width={760}
      >
        <Form form={form} layout="vertical" onFinish={submitUser}>
          <Tabs
            items={[
              {
                key: "base",
                label: "基本信息",
                children: (
                  <>
                    <Form.Item name="username" label="账号" rules={[{ required: !editingUser }]}>
                      <Input disabled={Boolean(editingUser)} />
                    </Form.Item>
                    <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                    <Form.Item name="role" label="角色" rules={[{ required: true }]}>
                      <Select
                        options={roleOptions}
                        onChange={(role: UserRole) => {
                          form.setFieldsValue({ permissions: normalizePermissions(roleDefaultPermissions[role]) });
                        }}
                      />
                    </Form.Item>
                    <Form.Item
                      name="password"
                      label={editingUser ? "新密码" : "密码"}
                      rules={[{ required: !editingUser, min: 8 }]}
                    >
                      <Input.Password />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: "permissions",
                label: "功能权限",
                children: (
                  <Form.Item name="permissions" noStyle>
                    <PermissionMatrix />
                  </Form.Item>
                ),
              },
              {
                key: "stores",
                label: "门店权限",
                children: (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message="门店权限是数据范围"
                      description="例如用户同时拥有“查看对账”和某些门店权限时，只能看到这些门店的流水和审批候选；如果没有对应功能权限，即使配置了门店也不能进入或维护该功能。管理员默认拥有全部门店。"
                    />
                    <Form.Item name="store_ids" label="可管理门店">
                      <Select
                        mode="multiple"
                        showSearch
                        allowClear
                        optionFilterProp="label"
                        placeholder="选择该用户可以查看和维护的门店"
                        options={stores.map((store) => ({ label: store.name, value: store.id }))}
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Modal>
    </AppShell>
  );
}
