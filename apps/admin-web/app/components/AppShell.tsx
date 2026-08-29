"use client";

import { Button, Layout, Menu, Typography } from "antd";
import type { MenuProps } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { apiClient } from "../lib/api";

const { Header, Sider, Content } = Layout;

const routeItems = [
  { key: "/", label: <Link href="/">首页仪表盘</Link>, group: "overview" },
  { key: "/ledgers", label: <Link href="/ledgers">门店账套</Link>, group: "operations" },
  { key: "/revenue", label: <Link href="/revenue">营业收入</Link>, group: "operations" },
  { key: "/expenses", label: <Link href="/expenses">支出明细</Link>, group: "operations" },
  { key: "/bank", label: <Link href="/bank">银行流水</Link>, group: "operations" },
  { key: "/matching", label: <Link href="/matching">匹配工作台</Link>, group: "operations" },
  { key: "/reports", label: <Link href="/reports">财务报表</Link>, group: "reports" },
  { key: "/stores", label: <Link href="/stores">门店管理</Link>, group: "master" },
  { key: "/categories", label: <Link href="/categories">费用分类</Link>, group: "master" },
  { key: "/suppliers", label: <Link href="/suppliers">供应商档案</Link>, group: "master" },
  { key: "/revenue-channels", label: <Link href="/revenue-channels">收入渠道</Link>, group: "master" },
  { key: "/dingtalk", label: <Link href="/dingtalk">钉钉同步设置</Link>, group: "system" },
  { key: "/shareholder-grants", label: <Link href="/shareholder-grants">股东授权</Link>, group: "system" },
  { key: "/audit", label: <Link href="/audit">操作日志</Link>, group: "system" },
  { key: "/users", label: <Link href="/users">用户管理</Link>, group: "system" },
  { key: "/settings", label: <Link href="/settings">系统设置</Link>, group: "system" },
];

const menuItems: MenuProps["items"] = [
  { key: "/", label: <Link href="/">首页仪表盘</Link> },
  {
    key: "operations",
    label: "做账作业",
    children: routeItems.filter((item) => item.group === "operations").map(({ key, label }) => ({ key, label })),
  },
  {
    key: "reports",
    label: "报表",
    children: routeItems.filter((item) => item.group === "reports").map(({ key, label }) => ({ key, label })),
  },
  {
    key: "master",
    label: "基础资料",
    children: routeItems.filter((item) => item.group === "master").map(({ key, label }) => ({ key, label })),
  },
  {
    key: "system",
    label: "系统",
    children: routeItems.filter((item) => item.group === "system").map(({ key, label }) => ({ key, label })),
  },
];

interface AppShellProps {
  title: string;
  kicker?: string;
  action?: any;
  children: any;
}

export function AppShell({ title, kicker = "FINANCE OPERATIONS", action, children }: AppShellProps) {
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const selectedKey =
    routeItems.find((item) => item.key !== "/" && pathname.startsWith(item.key))?.key ?? "/";

  useEffect(() => {
    let ignore = false;

    async function checkSession() {
      try {
        const user = await apiClient.auth.me();
        if (!ignore) {
          setDisplayName(user.display_name);
        }
      } catch {
        if (!ignore) {
          window.location.href = "/login";
        }
      }
    }

    checkSession();
    return () => {
      ignore = true;
    };
  }, []);

  async function logout() {
    await apiClient.auth.logout().catch(() => null);
    window.location.href = "/login";
  }

  return (
    <Layout className="app-shell">
      <Sider
        width={248}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        className="sidebar"
      >
        <div className="brand">
          <Typography.Title level={4}>{collapsed ? "FH" : "fin-hub"}</Typography.Title>
          {!collapsed ? <Typography.Text>蘑说财务管理系统</Typography.Text> : null}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={["operations", "reports", "master", "system"]}
          items={menuItems}
        />
      </Sider>
      <Layout>
        <Header className="topbar">
          <div>
            <Typography.Text className="topbar-kicker">{kicker}</Typography.Text>
            <Typography.Title level={3}>{title}</Typography.Title>
          </div>
          <div className="topbar-actions">
            {action ?? <Button type="primary">进入上月做账</Button>}
            {displayName ? <Typography.Text className="user-pill">{displayName}</Typography.Text> : null}
            <Button onClick={logout}>退出</Button>
          </div>
        </Header>
        <Content className="content">{children}</Content>
      </Layout>
    </Layout>
  );
}
