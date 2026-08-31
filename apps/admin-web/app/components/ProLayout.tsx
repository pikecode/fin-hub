"use client";

import { useState, useEffect } from "react";
import { Layout, Menu, Avatar, Dropdown, Button, Breadcrumb } from "antd";
import type { MenuProps } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  DashboardOutlined,
  BankOutlined,
  BarChartOutlined,
  ShopOutlined,
  TagsOutlined,
  DingtalkOutlined,
  UserOutlined,
  FileTextOutlined,
  SettingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";
import type { CurrentUser, PermissionKey } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";

const { Sider, Content } = Layout;

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  permission: PermissionKey;
}

interface NavSection {
  key: string;
  label: string;
  children: NavItem[];
}

const navigationSections: NavSection[] = [
  {
    key: "workspace",
    label: "工作台",
    children: [
      {
        key: "/",
        icon: <DashboardOutlined />,
        label: "仪表盘",
        permission: "dashboard.view",
      },
      {
        key: "/finance/reconciliation",
        icon: <BankOutlined />,
        label: "财务对账",
        permission: "reconciliation.view",
      },
    ],
  },
  {
    key: "sync",
    label: "数据同步",
    children: [
      {
        key: "/dingtalk",
        icon: <DingtalkOutlined />,
        label: "钉钉同步",
        permission: "dingtalk.view",
      },
    ],
  },
  {
    key: "reports",
    label: "报表分析",
    children: [
      {
        key: "/reports",
        icon: <BarChartOutlined />,
        label: "财务报表",
        permission: "reports.view",
      },
    ],
  },
  {
    key: "master",
    label: "基础档案",
    children: [
      {
        key: "/stores",
        icon: <ShopOutlined />,
        label: "门店管理",
        permission: "stores.view",
      },
      {
        key: "/categories",
        icon: <TagsOutlined />,
        label: "费用分类",
        permission: "categories.view",
      },
    ],
  },
  {
    key: "system",
    label: "系统管理",
    children: [
      {
        key: "/audit",
        icon: <FileTextOutlined />,
        label: "操作日志",
        permission: "audit.view",
      },
      {
        key: "/users",
        icon: <UserOutlined />,
        label: "用户管理",
        permission: "users.view",
      },
      {
        key: "/settings",
        icon: <SettingOutlined />,
        label: "系统设置",
        permission: "settings.manage",
      },
    ],
  },
];

function visibleNavigationSections(currentUser: CurrentUser | null): NavSection[] {
  if (!currentUser) {
    return navigationSections;
  }
  const permissions = new Set(currentUser.permissions);
  return navigationSections
    .map((section) => ({
      ...section,
      children: section.children.filter((item) => permissions.has(item.permission)),
    }))
    .filter((section) => section.children.length > 0);
}

function menuItemsForSections(sections: NavSection[]): MenuProps["items"] {
  return sections.map((section) => ({
    key: section.key,
    label: section.label,
    type: "group",
    children: section.children.map((item) => ({
      key: item.key,
      icon: item.icon,
      label: <Link href={item.key}>{item.label}</Link>,
    })),
  }));
}

function findActiveNav(pathname: string, sections: NavSection[]) {
  const allItems = sections.flatMap((section) =>
    section.children.map((item) => ({ section: section.label, item })),
  );
  return allItems
    .filter(({ item }) => item.key === "/" ? pathname === "/" : pathname.startsWith(item.key))
    .sort((left, right) => right.item.key.length - left.item.key.length)[0];
}

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
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const visibleSections = visibleNavigationSections(currentUser);
  const activeNav = findActiveNav(pathname, visibleSections);
  const menuItems = menuItemsForSections(visibleSections);

  useEffect(() => {
    const name = localStorage.getItem("user_name");
    setDisplayName(name);
    apiClient.auth.me()
      .then((user) => {
        setCurrentUser(user);
        setDisplayName(user.display_name);
        localStorage.setItem("user_name", user.display_name);
      })
      .catch(() => {
        router.push("/login");
      });
  }, [router]);

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
    <Layout className="pro-layout">
      <Sider
        className="sidebar"
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={240}
      >
        <div className="brand">
          <h4>{collapsed ? "FH" : "Fin Hub"}</h4>
          {!collapsed ? <span>Finance Operations</span> : null}
        </div>
        <Menu
          className="sidebar-menu"
          theme="light"
          mode="inline"
          selectedKeys={[pathname]}
          items={menuItems}
        />
      </Sider>
      <Layout className="app-main" style={{ marginLeft: collapsed ? 80 : 240 }}>
        <div className="app-header">
          <div className="app-header-title-area">
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              className="app-header-collapse-button"
            />
            <div className="app-header-title-stack">
              <Breadcrumb
                className="app-header-breadcrumb"
                items={[
                  { title: activeNav?.section ?? "后台管理" },
                  { title: activeNav?.item.label ?? title },
                ]}
              />
              <h1 className="app-header-title">{title}</h1>
              {kicker ? <div className="app-header-kicker">{kicker}</div> : null}
            </div>
          </div>
          <div className="app-header-actions">
            {action}
            <Dropdown menu={userMenu} placement="bottomRight">
              <div className="app-header-user">
                <Avatar
                  size={28}
                  className="app-header-avatar"
                  style={{ backgroundColor: "#14b8a6" }}
                  icon={!displayName ? <UserOutlined /> : undefined}
                >
                  {displayName?.[0]}
                </Avatar>
                <span style={{ fontWeight: 500 }}>{displayName || "用户"}</span>
              </div>
            </Dropdown>
          </div>
        </div>
        <Content
          className="app-content"
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}

// 兼容旧的 AppShell 导出
export { ProLayout as AppShell };
