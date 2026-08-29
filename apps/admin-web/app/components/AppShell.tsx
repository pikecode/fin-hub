"use client";

import { Button, Layout, Menu, Typography } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { apiClient } from "../lib/api";

const { Header, Sider, Content } = Layout;

const menuItems = [
  { key: "/", label: <Link href="/">首页仪表盘</Link> },
  { key: "/stores", label: <Link href="/stores">门店管理</Link> },
  { key: "/ledgers", label: <Link href="/ledgers">门店账套</Link> },
  { key: "/categories", label: <Link href="/categories">费用分类</Link> },
  { key: "/suppliers", label: <Link href="/suppliers">供应商档案</Link> },
  { key: "/revenue-channels", label: <Link href="/revenue-channels">收入渠道</Link> },
  { key: "/revenue", label: <Link href="/revenue">营业收入</Link> },
  { key: "/expenses", label: <Link href="/expenses">支出明细</Link> },
  { key: "/bank", label: <Link href="/bank">银行流水</Link> },
  { key: "/matching", label: <Link href="/matching">匹配工作台</Link> },
  { key: "/dingtalk", label: <Link href="/dingtalk">钉钉同步设置</Link> },
  { key: "/reports", label: <Link href="/reports">财务报表</Link> },
  { key: "/shareholder-grants", label: <Link href="/shareholder-grants">股东授权</Link> },
  { key: "/audit", label: <Link href="/audit">操作日志</Link> },
  { key: "/users", label: <Link href="/users">用户管理</Link> },
  { key: "/settings", label: <Link href="/settings">系统设置</Link> },
];

interface AppShellProps {
  title: string;
  action?: any;
  children: any;
}

export function AppShell({ title, action, children }: AppShellProps) {
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState("");
  const selectedKey =
    menuItems.find((item) => item.key !== "/" && pathname.startsWith(item.key))?.key ?? "/";

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
      <Sider width={236} className="sidebar">
        <div className="brand">
          <Typography.Title level={4}>fin-hub</Typography.Title>
          <Typography.Text>蘑说财务管理系统</Typography.Text>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={menuItems} />
      </Sider>
      <Layout>
        <Header className="topbar">
          <Typography.Title level={3}>{title}</Typography.Title>
          <div className="topbar-actions">
            {action ?? <Button type="primary">进入上月做账</Button>}
            {displayName ? <Typography.Text type="secondary">{displayName}</Typography.Text> : null}
            <Button onClick={logout}>退出</Button>
          </div>
        </Header>
        <Content className="content">{children}</Content>
      </Layout>
    </Layout>
  );
}
