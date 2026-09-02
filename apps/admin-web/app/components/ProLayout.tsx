"use client";

import { useState, useEffect, useMemo } from "react";
import { Layout, Menu, Avatar, Dropdown, Button, Breadcrumb } from "antd";
import type { MenuProps } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BarChartOutlined,
  CloudSyncOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ShopOutlined,
  TagsOutlined,
  DingtalkOutlined,
  UserOutlined,
  FileTextOutlined,
  SettingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  FolderOpenOutlined,
  WalletOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import type { CurrentUser, PermissionKey } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";

const { Sider, Content } = Layout;

let cachedCurrentUser: CurrentUser | null = null;
let pendingCurrentUser: Promise<CurrentUser> | null = null;

interface NavItem {
  key: string;
  href?: string;
  label: string;
  icon: React.ReactNode;
  permission?: PermissionKey;
  children?: NavItem[];
}

const navigationTree: NavItem[] = [
  {
    key: "/",
    icon: <DashboardOutlined />,
    label: "工作台",
    permission: "dashboard.view",
  },
  {
    key: "store-ledgers-tree",
    icon: <FolderOpenOutlined />,
    label: "门店套帐",
    permission: "stores.view",
    children: [
      {
        key: "/store-ledgers",
        icon: <ShopOutlined />,
        label: "门店入口",
        permission: "stores.view",
      },
      {
        key: "/ledgers",
        icon: <FolderOpenOutlined />,
        label: "账期管理",
        permission: "reconciliation.view",
      },
    ],
  },
  {
    key: "/master-data",
    icon: <DatabaseOutlined />,
    label: "基础数据",
    children: [
      {
        key: "/stores",
        icon: <ShopOutlined />,
        label: "门店资料",
        permission: "stores.view",
      },
      {
        key: "/revenue-channels",
        icon: <WalletOutlined />,
        label: "收入渠道",
        permission: "revenue.view",
      },
      {
        key: "/categories",
        icon: <TagsOutlined />,
        label: "费用分类",
        permission: "categories.view",
      },
      {
        key: "/suppliers",
        icon: <TeamOutlined />,
        label: "供应商",
        permission: "categories.view",
      },
    ],
  },
  {
    key: "/sync",
    icon: <CloudSyncOutlined />,
    label: "数据同步",
    children: [
      {
        key: "/dingtalk",
        icon: <DingtalkOutlined />,
        label: "钉钉同步",
        permission: "dingtalk.view",
      },
      {
        key: "/tasks",
        icon: <CloudSyncOutlined />,
        label: "任务中心",
        permission: "dingtalk.view",
      },
    ],
  },
  {
    key: "/reports-group",
    icon: <BarChartOutlined />,
    label: "报表与审计",
    children: [
      {
        key: "/reports",
        icon: <BarChartOutlined />,
        label: "财务报表",
        permission: "reports.view",
      },
      {
        key: "/audit",
        icon: <FileTextOutlined />,
        label: "操作日志",
        permission: "audit.view",
      },
    ],
  },
  {
    key: "/system",
    icon: <SettingOutlined />,
    label: "系统管理",
    children: [
      {
        key: "/users",
        icon: <UserOutlined />,
        label: "用户管理",
        permission: "users.view",
      },
      {
        key: "/shareholder-grants",
        icon: <TeamOutlined />,
        label: "股东授权",
        permission: "users.manage",
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

function visibleNavigationTree(currentUser: CurrentUser | null): NavItem[] {
  if (!currentUser) {
    return navigationTree;
  }
  const permissions = new Set(currentUser.permissions);
  function filterItem(item: NavItem): NavItem | null {
    if (item.children?.length) {
      const children = item.children.map(filterItem).filter((child): child is NavItem => Boolean(child));
      return (item.permission ? permissions.has(item.permission) : false) || children.length
        ? { ...item, children }
        : null;
    }
    return item.permission && permissions.has(item.permission) ? item : null;
  }
  return navigationTree.map(filterItem).filter((item): item is NavItem => Boolean(item));
}

function currentStoreIdFromPath(pathname: string) {
  const match = pathname.match(/^\/store-ledgers\/([^/]+)/);
  return match?.[1] ?? null;
}

function selectedMenuKey(pathname: string, hasStoreContext: boolean) {
  if (/^\/store-ledgers(\/|$)/.test(pathname)) return "/store-ledgers";
  if (hasStoreContext && ["/bank", "/revenue", "/finance/reconciliation", "/finance/revenue-reconciliation"].includes(pathname)) return "/store-ledgers";
  return pathname;
}

function menuItemForNavItem(item: NavItem): NonNullable<MenuProps["items"]>[number] {
  if (item.children?.length) {
    return {
      key: item.key,
      icon: item.icon,
      label: item.label,
      children: item.children.map((child) => menuItemForNavItem(child)),
    };
  }
  return {
    key: item.key,
    icon: item.icon,
    label: item.label,
  };
}

function menuItemsForTree(items: NavItem[]): MenuProps["items"] {
  return items.map((item) => menuItemForNavItem(item));
}

function findNavItemByKey(items: NavItem[], key: string): NavItem | null {
  for (const item of items) {
    if (item.key === key) return item;
    const child = item.children?.length ? findNavItemByKey(item.children, key) : null;
    if (child) return child;
  }
  return null;
}

function navTrail(pathname: string, items: NavItem[], hasStoreContext: boolean) {
  const selectedKey = selectedMenuKey(pathname, hasStoreContext);
  function flatten(item: NavItem, parents: NavItem[]): Array<{ parents: NavItem[]; item: NavItem }> {
    const current = { parents, item };
    return [current, ...(item.children ?? []).flatMap((child) => flatten(child, [...parents, item]))];
  }
  const allItems = items.flatMap((item) => flatten(item, []));
  return allItems
    .filter(({ item }) => {
      const itemPath = item.key.split("?")[0];
      return item.key === selectedKey || (itemPath === "/" ? pathname === "/" : pathname.startsWith(itemPath));
    })
    .sort((left, right) => right.item.key.length - left.item.key.length)[0];
}

function defaultOpenKeysForPath(pathname: string, items: NavItem[], hasStoreContext: boolean) {
  const active = navTrail(pathname, items, hasStoreContext);
  return Array.from(
    new Set([
      ...items.filter((item) => item.children?.length).map((item) => item.key),
      ...(active?.parents.map((item) => item.key) ?? []),
    ]),
  );
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
  const searchParams = useSearchParams();
  const currentStoreId = currentStoreIdFromPath(pathname) ?? searchParams.get("store_id");
  const hasStoreContext = Boolean(currentStoreId);
  const [collapsed, setCollapsed] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const visibleTree = useMemo(() => visibleNavigationTree(currentUser), [currentUser]);
  const activeNav = useMemo(() => navTrail(pathname, visibleTree, hasStoreContext), [pathname, visibleTree, hasStoreContext]);
  const menuItems = useMemo(() => menuItemsForTree(visibleTree), [visibleTree]);
  const defaultOpenKeys = useMemo(
    () => defaultOpenKeysForPath(pathname, visibleTree, hasStoreContext),
    [pathname, visibleTree, hasStoreContext],
  );

  useEffect(() => {
    const name = localStorage.getItem("user_name");
    setDisplayName(name);
    if (cachedCurrentUser) {
      setCurrentUser(cachedCurrentUser);
      setDisplayName(cachedCurrentUser.display_name);
      return;
    }
    pendingCurrentUser = pendingCurrentUser ?? apiClient.auth.me();
    pendingCurrentUser
      .then((user) => {
        cachedCurrentUser = user;
        pendingCurrentUser = null;
        setCurrentUser(user);
        setDisplayName(user.display_name);
        localStorage.setItem("user_name", user.display_name);
      })
      .catch(() => {
        cachedCurrentUser = null;
        pendingCurrentUser = null;
        router.push("/login");
      });
  }, [router]);

  async function logout() {
    await apiClient.auth.logout();
    cachedCurrentUser = null;
    pendingCurrentUser = null;
    localStorage.removeItem("user_name");
    router.push("/login");
  }

  function handleMenuClick({ key }: { key: string }) {
    const item = findNavItemByKey(visibleTree, key);
    if (!item || item.children?.length) return;
    const href = item.href ?? item.key;
    if (href === pathname) return;
    router.push(href);
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
          selectedKeys={[selectedMenuKey(pathname, hasStoreContext)]}
          defaultOpenKeys={defaultOpenKeys}
          onClick={handleMenuClick}
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
                  { title: activeNav?.parents[0]?.label ?? "后台管理" },
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
