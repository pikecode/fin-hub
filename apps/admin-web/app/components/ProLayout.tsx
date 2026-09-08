"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Layout, Menu, Avatar, Dropdown, Button, Breadcrumb, Tabs } from "antd";
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
} from "@ant-design/icons";
import type { CurrentUser, PermissionKey } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";
import { getConfirmLeaveMessage } from "./navigationGuard";

const { Sider, Content } = Layout;
const MAX_OPEN_PAGE_TABS = 6;

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

interface OpenPageTab {
  key: string;
  href: string;
  title: string;
  kicker?: string;
}

const OPEN_PAGE_TABS_STORAGE_KEY = "fin-hub.open-page-tabs";
const STORE_CONTEXT_PATHS = new Set([
  "/bank",
  "/revenue",
  "/finance/reconciliation",
  "/finance/revenue-reconciliation",
]);

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

function readStoredOpenTabs(): OpenPageTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(OPEN_PAGE_TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        key: String((item as OpenPageTab).key || ""),
        href: String((item as OpenPageTab).href || ""),
        title: String((item as OpenPageTab).title || ""),
        kicker: typeof (item as OpenPageTab).kicker === "string" ? (item as OpenPageTab).kicker : undefined,
      }))
      .filter((item) => item.key && item.href && item.title)
      .slice(-MAX_OPEN_PAGE_TABS);
  } catch {
    return [];
  }
}

/**
 * Validates tabs against current user permissions.
 * Removes tabs that point to routes the user no longer has access to.
 */
function validateTabsAgainstPermissions(tabs: OpenPageTab[], navItems: NavItem[]): OpenPageTab[] {
  const validPaths = new Set<string>();

  function collectPaths(items: NavItem[]) {
    items.forEach((item) => {
      if (item.key && !item.children?.length) {
        validPaths.add(item.key);
      }
      if (item.children) {
        collectPaths(item.children);
      }
    });
  }

  collectPaths(navItems);

  return tabs.filter((tab) => {
    const tabPath = tab.href.split("?")[0];
    const tabParams = new URLSearchParams(tab.href.split("?")[1] ?? "");

    if (tabPath === "/") return true;
    if (STORE_CONTEXT_PATHS.has(tabPath) && tabParams.has("store_id") && validPaths.has("/store-ledgers")) return true;

    for (const path of validPaths) {
      if (path === "/" && tabPath === "/") return true;
      if (path !== "/" && tabPath.startsWith(path)) return true;
    }

    return false;
  });
}

function normalizePageHref(pathname: string, searchParams: URLSearchParams) {
  const params = new URLSearchParams();
  if (/^\/store-ledgers\/[^/]+\/approvals$/.test(pathname)) {
    const period = searchParams.get("period");
    if (period) params.set("period", period);
    return `${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  }
  if (/^\/store-ledgers\/[^/]+$/.test(pathname)) {
    const period = searchParams.get("period");
    if (period) params.set("period", period);
    return `${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  }
  if (pathname === "/bank" || pathname === "/revenue" || pathname === "/finance/reconciliation" || pathname === "/finance/revenue-reconciliation") {
    const storeId = searchParams.get("store_id");
    const ledgerPeriod = searchParams.get("ledger_period");
    if (storeId) params.set("store_id", storeId);
    if (ledgerPeriod) params.set("ledger_period", ledgerPeriod);
    return `${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  }
  const passthrough = new URLSearchParams();
  Array.from(searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .forEach(([key, value]) => {
      if (key === "_rsc") return;
      passthrough.set(key, value);
    });
  return `${pathname}${passthrough.toString() ? `?${passthrough.toString()}` : ""}`;
}

function tabLabel(title: string, kicker?: string) {
  return kicker ? `${title} · ${kicker}` : title;
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
  const [openedTabs, setOpenedTabs] = useState<OpenPageTab[]>([]);
  const [hasLoadedStoredTabs, setHasLoadedStoredTabs] = useState(false);
  const draggedTabKeyRef = useRef<string | null>(null);
  const visibleTree = useMemo(() => visibleNavigationTree(currentUser), [currentUser]);
  const activeNav = useMemo(() => navTrail(pathname, visibleTree, hasStoreContext), [pathname, visibleTree, hasStoreContext]);
  const menuItems = useMemo(() => menuItemsForTree(visibleTree), [visibleTree]);
  const defaultOpenKeys = useMemo(
    () => defaultOpenKeysForPath(pathname, visibleTree, hasStoreContext),
    [pathname, visibleTree, hasStoreContext],
  );
  const activeTabKey = useMemo(() => normalizePageHref(pathname, new URLSearchParams(searchParams.toString())), [pathname, searchParams]);
  const activeTabHref = useMemo(() => normalizePageHref(pathname, new URLSearchParams(searchParams.toString())), [pathname, searchParams]);

  useEffect(() => {
    setOpenedTabs(readStoredOpenTabs());
    setHasLoadedStoredTabs(true);
  }, []);

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

  useEffect(() => {
    if (!hasLoadedStoredTabs || !currentUser) return;
    const validatedTabs = validateTabsAgainstPermissions(openedTabs, visibleTree);
    if (validatedTabs.length !== openedTabs.length) {
      setOpenedTabs(validatedTabs);
      const isCurrentTabInvalid = !validatedTabs.some((tab) => tab.key === activeTabKey);
      if (isCurrentTabInvalid && validatedTabs.length > 0) {
        router.push(validatedTabs[0].href);
      } else if (isCurrentTabInvalid && validatedTabs.length === 0) {
        router.push("/");
      }
    }
  }, [activeTabKey, currentUser, hasLoadedStoredTabs, openedTabs, router, visibleTree]);

  useEffect(() => {
    if (!hasLoadedStoredTabs) return;
    setOpenedTabs((currentTabs) => {
      const nextTab: OpenPageTab = {
        key: activeTabKey,
        href: activeTabHref,
        title,
        kicker,
      };
      const existingIndex = currentTabs.findIndex((item) => item.key === activeTabKey);
      if (existingIndex >= 0) {
        const existing = currentTabs[existingIndex];
        if (existing.href === nextTab.href && existing.title === nextTab.title && existing.kicker === nextTab.kicker) {
          return currentTabs;
        }
        const updatedTabs = [...currentTabs];
        updatedTabs[existingIndex] = nextTab;
        return updatedTabs;
      }
      if (currentTabs.length >= MAX_OPEN_PAGE_TABS) {
        return [...currentTabs.slice(-(MAX_OPEN_PAGE_TABS - 1)), nextTab];
      }
      return [...currentTabs, nextTab];
    });
  }, [activeTabHref, activeTabKey, hasLoadedStoredTabs, kicker, title]);

  useEffect(() => {
    if (!hasLoadedStoredTabs) return;
    localStorage.setItem(OPEN_PAGE_TABS_STORAGE_KEY, JSON.stringify(openedTabs));
  }, [hasLoadedStoredTabs, openedTabs]);

  async function logout() {
    await apiClient.auth.logout();
    cachedCurrentUser = null;
    pendingCurrentUser = null;
    localStorage.removeItem("user_name");
    localStorage.removeItem(OPEN_PAGE_TABS_STORAGE_KEY);
    router.push("/login");
  }

  function handleMenuClick({ key }: { key: string }) {
    const item = findNavItemByKey(visibleTree, key);
    if (!item || item.children?.length) return;
    const href = item.href ?? item.key;
    if (href === pathname) return;
    const leaveMessage = getConfirmLeaveMessage();
    if (leaveMessage && !window.confirm(leaveMessage)) return;
    router.push(href);
  }

  function openTab(tab: OpenPageTab) {
    if (tab.href !== activeTabHref) {
      const leaveMessage = getConfirmLeaveMessage();
      if (leaveMessage && !window.confirm(leaveMessage)) return;
      try {
        router.push(tab.href);
      } catch (error) {
        console.error("Failed to navigate to tab:", error);
        closeTab(tab.key);
      }
    }
  }

  function moveTab(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) return;
    setOpenedTabs((currentTabs) => {
      const sourceIndex = currentTabs.findIndex((tab) => tab.key === sourceKey);
      const targetIndex = currentTabs.findIndex((tab) => tab.key === targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return currentTabs;
      const nextTabs = [...currentTabs];
      const [moved] = nextTabs.splice(sourceIndex, 1);
      nextTabs.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, moved);
      return nextTabs;
    });
  }

  function closeTab(tabKey: string) {
    setOpenedTabs((currentTabs) => {
      const index = currentTabs.findIndex((tab) => tab.key === tabKey);
      if (index < 0) return currentTabs;
      const nextTabs = currentTabs.filter((tab) => tab.key !== tabKey);
      if (tabKey === activeTabKey) {
        const fallback = nextTabs[index - 1] ?? nextTabs[index] ?? nextTabs[0];
        const leaveMessage = getConfirmLeaveMessage();
        if (leaveMessage && !window.confirm(leaveMessage)) {
          return currentTabs;
        }
        router.push(fallback?.href ?? "/");
      }
      return nextTabs;
    });
  }

  function closeOtherTabs(keepTabKey: string) {
    setOpenedTabs((currentTabs) => {
      const keepTab = currentTabs.find((tab) => tab.key === keepTabKey);
      if (!keepTab) return currentTabs;
      if (keepTabKey !== activeTabKey) {
        const leaveMessage = getConfirmLeaveMessage();
        if (leaveMessage && !window.confirm(leaveMessage)) return currentTabs;
        router.push(keepTab.href);
      }
      return [keepTab];
    });
  }

  function closeAllTabs() {
    const leaveMessage = getConfirmLeaveMessage();
    if (leaveMessage && !window.confirm(leaveMessage)) return;
    setOpenedTabs([]);
    router.push("/");
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
          <div className="app-header-main-row">
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
                <div className="app-header-kicker" aria-hidden={!kicker}>
                  {kicker || " "}
                </div>
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
          <div className="app-header-tabs-row">
            <div className="app-open-pages-label">已打开页面 {openedTabs.length}/{MAX_OPEN_PAGE_TABS}</div>
            <Tabs
              className="app-open-pages-tabs"
              type="editable-card"
              hideAdd
              size="small"
              animated={false}
              activeKey={activeTabKey}
              onChange={(key) => {
                const tab = openedTabs.find((item) => item.key === key);
                if (tab) openTab(tab);
              }}
              onEdit={(targetKey, actionType) => {
                if (actionType !== "remove") return;
                closeTab(String(targetKey));
              }}
              items={openedTabs.map((tab) => ({
                key: tab.key,
                label: (
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: "close-others",
                          label: "关闭其他",
                          disabled: openedTabs.length <= 1,
                          onClick: () => closeOtherTabs(tab.key),
                        },
                        {
                          key: "close-all",
                          label: "关闭所有",
                          onClick: () => closeAllTabs(),
                        },
                      ],
                    }}
                    trigger={["contextMenu"]}
                  >
                    <span
                      className="app-open-page-tab-label"
                      title={tabLabel(tab.title, tab.kicker)}
                      draggable
                      onDragStart={(event) => {
                        draggedTabKeyRef.current = tab.key;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", tab.key);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const sourceKey = draggedTabKeyRef.current || event.dataTransfer.getData("text/plain");
                        draggedTabKeyRef.current = null;
                        moveTab(sourceKey, tab.key);
                      }}
                      onDragEnd={() => {
                        draggedTabKeyRef.current = null;
                      }}
                    >
                      {tabLabel(tab.title, tab.kicker)}
                    </span>
                  </Dropdown>
                ),
                closable: true,
              }))}
            />
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
