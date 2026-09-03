"use client";

import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, message } from "antd";
import { useEffect, useMemo, useState } from "react";
import { FolderOutlined, PlusOutlined, ShopOutlined } from "@ant-design/icons";
import type { CurrentUser, Store, StoreCreate, StoreGroup, StoreGroupCreate } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { StatusBadge } from "../components/StatusBadge";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
import { apiClient } from "../lib/api";

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [groups, setGroups] = useState<StoreGroup[]>([]);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStoreModalOpen, setIsStoreModalOpen] = useState(false);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [isGroupEditorOpen, setIsGroupEditorOpen] = useState(false);
  const [isAssignGroupOpen, setIsAssignGroupOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [editingGroup, setEditingGroup] = useState<StoreGroup | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<StoreCreate>();
  const [groupForm] = Form.useForm<StoreGroupCreate>();
  const [assignGroupForm] = Form.useForm<{ group_id: string | null }>();

  const canManageGroups = currentUser?.permissions.includes("stores.manage") ?? false;
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const groupOptions = useMemo(
    () => groups.map((group) => ({ label: group.name, value: group.id })),
    [groups],
  );

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, storeGroups, user] = await Promise.all([
        apiClient.stores.list("?page_size=500"),
        apiClient.stores.listGroups(),
        apiClient.auth.me(),
      ]);
      setStores(storePage.items);
      setGroups(storeGroups);
      setCurrentUser(user);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function submitStore(values: StoreCreate) {
    setIsLoading(true);
    try {
      const payload = {
        ...values,
        group_id: canManageGroups ? values.group_id ?? null : undefined,
      };
      if (editingStore) {
        await apiClient.stores.update(editingStore.id, payload);
        message.success("门店已更新");
      } else {
        await apiClient.stores.create(payload);
        message.success("门店已创建");
      }
      setIsStoreModalOpen(false);
      setEditingStore(null);
      form.resetFields();
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function submitGroup(values: StoreGroupCreate) {
    setIsLoading(true);
    try {
      if (editingGroup) {
        await apiClient.stores.updateGroup(editingGroup.id, values);
        message.success("分组已更新");
      } else {
        await apiClient.stores.createGroup(values);
        message.success("分组已创建");
      }
      setIsGroupEditorOpen(false);
      setEditingGroup(null);
      groupForm.resetFields();
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateStoreModal() {
    setEditingStore(null);
    form.resetFields();
    setIsStoreModalOpen(true);
  }

  function openEditStoreModal(store: Store) {
    setEditingStore(store);
    form.setFieldsValue({
      name: store.name,
      group_id: store.group_id,
      dingtalk_dept_id: store.dingtalk_dept_id,
      contact_person: store.contact_person,
      phone: store.phone,
      address: store.address,
    });
    setIsStoreModalOpen(true);
  }

  function openAssignGroupModal(store: Store) {
    setEditingStore(store);
    assignGroupForm.setFieldsValue({ group_id: store.group_id ?? null });
    setIsAssignGroupOpen(true);
  }

  function openCreateGroupModal() {
    setEditingGroup(null);
    groupForm.setFieldsValue({ name: "", sort_order: 0 });
    setIsGroupEditorOpen(true);
  }

  function openEditGroupModal(group: StoreGroup) {
    setEditingGroup(group);
    groupForm.setFieldsValue({ name: group.name, sort_order: group.sort_order });
    setIsGroupEditorOpen(true);
  }

  async function deleteGroup(group: StoreGroup) {
    setIsLoading(true);
    try {
      await apiClient.stores.deleteGroup(group.id);
      message.success(`已删除“${group.name}”，其下门店已转为未分组`);
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function toggleStatus(store: Store) {
    setIsLoading(true);
    try {
      await apiClient.stores.update(store.id, {
        status: store.status === "active" ? "inactive" : "active",
      });
      message.success("状态已更新");
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "状态更新失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function submitAssignGroup(values: { group_id: string | null }) {
    if (!editingStore) {
      return;
    }
    setIsLoading(true);
    try {
      await apiClient.stores.update(editingStore.id, { group_id: values.group_id ?? null });
      message.success(values.group_id ? "门店已归组" : "门店已取消分组");
      setIsAssignGroupOpen(false);
      setEditingStore(null);
      assignGroupForm.resetFields();
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "归组失败");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: EnterpriseTableColumn<Store>[] = [
    { title: "门店名称", key: "name", dataIndex: "name", width: 200 },
    {
      title: "虚拟分组",
      key: "group_id",
      dataIndex: "group_id",
      width: 160,
      render: (value: string | null | undefined) =>
        value ? <Tag color="cyan">{groupsById.get(value)?.name ?? "分组已删除"}</Tag> : <span style={{ color: "#94a3b8" }}>未分组</span>,
    },
    {
      title: "钉钉部门",
      key: "dingtalk_dept_id",
      dataIndex: "dingtalk_dept_id",
      width: 150,
      render: (value) => value || "-",
    },
    { title: "联系人", key: "contact_person", dataIndex: "contact_person", width: 120, render: (value) => value || "-" },
    { title: "电话", key: "phone", dataIndex: "phone", width: 140, render: (value) => value || "-" },
    { title: "地址", key: "address", dataIndex: "address", ellipsis: true, render: (value) => value || "-" },
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
          <Button type="link" size="small" onClick={() => openEditStoreModal(record)}>编辑</Button>
          {canManageGroups ? (
            <Button type="link" size="small" onClick={() => openAssignGroupModal(record)}>
              {record.group_id ? "调整分组" : "归组"}
            </Button>
          ) : null}
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
        <Space size={8}>
          {canManageGroups ? <Button icon={<FolderOutlined />} onClick={() => setIsGroupModalOpen(true)}>管理分组</Button> : null}
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateStoreModal}>新增门店</Button>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        {errorMessage && <Alert message="加载失败" description={errorMessage} type="error" showIcon closable />}
        <EnterpriseTable rowKey="id" columns={columns} dataSource={stores} loading={isLoading} exportFileName="门店列表" />
      </Space>

      <Modal
        title={<Space><ShopOutlined /><span>{editingStore ? "编辑门店" : "新增门店"}</span></Space>}
        open={isStoreModalOpen}
        onCancel={() => { setIsStoreModalOpen(false); setEditingStore(null); }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitStore}>
          <Form.Item name="name" label="门店名称" rules={[{ required: true, message: "请输入门店名称" }]}><Input placeholder="请输入门店名称" /></Form.Item>
          {canManageGroups ? <Form.Item name="group_id" label="虚拟分组"><Select allowClear placeholder="未分组" options={groupOptions} /></Form.Item> : null}
          <Form.Item name="dingtalk_dept_id" label="钉钉部门 ID"><Input placeholder="钉钉部门 ID" /></Form.Item>
          <Form.Item name="contact_person" label="联系人"><Input placeholder="联系人姓名" /></Form.Item>
          <Form.Item name="phone" label="联系电话"><Input placeholder="联系电话" /></Form.Item>
          <Form.Item name="address" label="门店地址"><Input placeholder="门店地址" /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title="门店归组"
        open={isAssignGroupOpen}
        onCancel={() => {
          setIsAssignGroupOpen(false);
          setEditingStore(null);
        }}
        onOk={() => assignGroupForm.submit()}
        confirmLoading={isLoading}
      >
        <Form form={assignGroupForm} layout="vertical" onFinish={submitAssignGroup}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={editingStore ? `门店：${editingStore.name}` : "选择要放入的虚拟分组"}
            description="这里只调整系统内部归类，不会改变钉钉部门，也不会影响门店权限。"
          />
          <Form.Item name="group_id" label="虚拟分组">
            <Select
              allowClear
              placeholder="未分组"
              options={groupOptions}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="门店虚拟分组"
        open={isGroupModalOpen}
        width={720}
        onCancel={() => setIsGroupModalOpen(false)}
        footer={<Button onClick={() => setIsGroupModalOpen(false)}>关闭</Button>}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ color: "#64748b" }}>仅用于系统内归类，不会改变钉钉部门或门店权限。</span>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateGroupModal}>新增分组</Button>
        </div>
        <Table<StoreGroup>
          rowKey="id"
          size="small"
          loading={isLoading}
          pagination={false}
          dataSource={groups}
          columns={[
            { title: "分组名称", dataIndex: "name" },
            { title: "门店数", dataIndex: "store_count", width: 100, align: "right" },
            { title: "排序", dataIndex: "sort_order", width: 90, align: "right" },
            {
              title: "操作",
              width: 150,
              render: (_, group) => (
                <Space size="small">
                  <Button type="link" size="small" onClick={() => openEditGroupModal(group)}>编辑</Button>
                  <Popconfirm title={`删除“${group.name}”分组？`} description="分组内门店不会删除，会转为未分组。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteGroup(group)}>
                    <Button type="link" danger size="small">删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={editingGroup ? "编辑门店分组" : "新增门店分组"}
        open={isGroupEditorOpen}
        onCancel={() => { setIsGroupEditorOpen(false); setEditingGroup(null); }}
        onOk={() => groupForm.submit()}
        confirmLoading={isLoading}
      >
        <Form form={groupForm} layout="vertical" onFinish={submitGroup}>
          <Form.Item name="name" label="分组名称" rules={[{ required: true, message: "请输入分组名称" }]}><Input placeholder="例如：华东区域、直营门店" /></Form.Item>
          <Form.Item name="sort_order" label="排序"><InputNumber min={0} precision={0} style={{ width: "100%" }} /></Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
