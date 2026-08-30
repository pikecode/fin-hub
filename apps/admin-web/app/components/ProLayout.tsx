"use client";

import { useState, useEffect } from "react";
import { Layout, Menu, Avatar, Dropdown, Button } from "antd";
import type { MenuProps } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  DashboardOutlined,
  SwapOutlined,
  BankOutlined,
  BarChartOutlined,
  ShopOutlined,
  TagsOutlined,
  TeamOutlined,
  CreditCardOutlined,
  DingtalkOutlined,
  UserOutlined,
  LockOutlined,
  FileTextOutlined,
  SettingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";
import { apiClient } from "../lib/api";

const { Header, Sider, Content } = Layout;

// 菜单配置
const menuItems: MenuProps["items"] = [
  {
    key: "workspace",
    label: "工作台",
    type: "group",
    children: [
      {
        key: "/",
        icon: <DashboardOutlined />,
        label: <Link href="/">仪表盘</Link>,
      },
      {
        key: "/matching",
        icon: <SwapOutlined />,
        label: <Link href="/matching">匹配工作台</Link>,
      },
      {
        key: "/finance/reconciliation",
        icon: <BankOutlined />,
        label: <Link href="/finance/reconciliation">财务对账</Link>,
      },
    ],
  },
  {
    key: "reports",
    label: "报表分析",
    type: "group",
    children: [
      {
        key: "/reports",
        icon: <BarChartOutlined />,
        label: <Link href="/reports">财务报表</Link>,
      },
      {
        key: "/dashboard",
        icon: <DashboardOutlined />,
        label: <Link href="/dashboard">数据分析</Link>,
      },
    ],
  },
  {
    key: "master",
    label: "基础档案",
    type: "group",
    children: [
      {
        key: "/stores",
        icon: <ShopOutlined />,
        label: <Link href="/stores">门店管理</Link>,
      },
      {
        key: "/categories",
        icon: <TagsOutlined />,
        label: <Link href="/categories">费用分类</Link>,
      },
      {
        key: "/suppliers",
        icon: <TeamOutlined />,
        label: <Link href="/suppliers">供应商档案</Link>,
      },
      {
        key: "/revenue-channels",
        icon: <CreditCardOutlined />,
        label: <Link href="/revenue-channels">收入渠道</Link>,
      },
    ],
  },
  {
    key: "system",
    label: "系统设置",
    type: "group",
    children: [
      {
        key: "/dingtalk",
        icon: <DingtalkOutlined />,
        label: <Link href="/dingtalk">钉钉同步设置</Link>,
      },
      {
        key: "/shareholder-grants",
        icon: <LockOutlined />,
        label: <Link href="/shareholder-grants">股东授权</Link>,
      },
      {
        key: "/audit",
        icon: <FileTextOutlined />,
        label: <Link href="/audit">操作日志</Link>,
      },
      {
        key: "/users",
        icon: <UserOutlined />,
        label: <Link href="/users">用户管理</Link>,
      },
      {
        key: "/settings",
        icon: <SettingOutlined />,
        label: <Link href="/settings">系统设置</Link>,
      },
    ],
  },
];

interface ProLayoutProps {
  title: string;
  kicker?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

export function ProLayout({ title, kicker, action, children }: ProLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    const name = localStorage.getItem("user_name");
    setDisplayName(name);
  }, []);

  async function logout() {
    await apiClient.auth.logout();
    localStorage.removeItem("user_name");
    router.push("/login");
  }

  const userMenu: MenuProps = {
    items: [
      {
        key: "profile",
        icon: <UserOutlined />,
        label: "个人设置",
      },
      {
        type: "divider",
      },
      {
        key: "logout",
        icon: <LogoutOutlined />,
        label: "退出登录",
        danger: true,
        onClick: logout,
      },
    ],
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={240}
        style={{
          overflow: "auto",
          height: "100vh",
          position: "fixed",
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 100,
        }}
      >
        <div
          style={{
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255, 255, 255, 0.05)",
          }}
        >
          <h1
            style={{
              color: "white",
              margin: 0,
              fontSize: collapsed ? 18 : 20,
              fontWeight: 700,
              letterSpacing: collapsed ? 0 : 1,
            }}
          >
            {collapsed ? "FH" : "fin-hub"}
          </h1>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[pathname]}
          items={menuItems}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Layout style={{ marginLeft: collapsed ? 80 : 240, transition: "all 0.2s" }}>
        <Header
          className="app-header"
        >
          <div className="app-header-title-area">
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              className="app-header-collapse-button"
            />
            <div className="app-header-title-stack">
              {kicker && (
                <div className="app-header-kicker">
                  {kicker}
                </div>
              )}
              <h1 className="app-header-title">{title}</h1>
            </div>
          </div>
          <div className="app-header-actions">
            {action}
            <Dropdown menu={userMenu} placement="bottomRight">
              <div className="app-header-user">
                <Avatar
                  style={{ backgroundColor: "#14b8a6" }}
                  icon={!displayName ? <UserOutlined /> : undefined}
                >
                  {displayName?.[0]}
                </Avatar>
                <span style={{ fontWeight: 500 }}>{displayName || "用户"}</span>
              </div>
            </Dropdown>
          </div>
        </Header>
        <Content
          style={{
            margin: 24,
            minHeight: "calc(100vh - 64px - 48px)",
            background: "#f0f2f5",
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}

// 兼容旧的 AppShell 导出
export { ProLayout as AppShell };
