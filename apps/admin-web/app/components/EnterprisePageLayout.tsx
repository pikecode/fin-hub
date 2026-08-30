import { Breadcrumb, Space, Dropdown } from "antd";
import type { BreadcrumbProps, MenuProps } from "antd";
import Link from "next/link";

interface PageAction {
  key: string;
  label: string;
  onClick: () => void;
  icon?: any;
  danger?: boolean;
  type?: "primary" | "default" | "dashed" | "link" | "text";
}

interface EnterprisePageLayoutProps {
  title: string;
  subtitle?: string;
  icon?: any;
  breadcrumbs?: { title: string; href?: string }[];
  primaryAction?: any;
  secondaryActions?: PageAction[];
  tabs?: any;
  children: any;
}

export function EnterprisePageLayout({
  title,
  subtitle,
  icon,
  breadcrumbs,
  primaryAction,
  secondaryActions,
  tabs,
  children,
}: EnterprisePageLayoutProps) {
  const breadcrumbItems: BreadcrumbProps["items"] = breadcrumbs?.map((crumb) => ({
    title: crumb.href ? <Link href={crumb.href}>{crumb.title}</Link> : crumb.title,
  }));

  const dropdownMenu: MenuProps = {
    items: secondaryActions?.map((action) => ({
      key: action.key,
      label: action.label,
      icon: action.icon,
      danger: action.danger,
      onClick: action.onClick,
    })),
  };

  return (
    <div className="enterprise-page">
      {/* 页面头部 */}
      <div className="page-header">
        {/* 面包屑 */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <div className="breadcrumb-wrapper">
            <Breadcrumb items={breadcrumbItems} />
          </div>
        )}

        {/* 标题区 */}
        <div className="page-title-wrapper">
          <div className="page-title-content">
            {icon && <div className="page-icon">{icon}</div>}

            <div className="page-title-text">
              <h1 className="page-title">{title}</h1>
              {subtitle && <p className="page-subtitle">{subtitle}</p>}
            </div>
          </div>

          {/* 操作按钮 */}
          {(primaryAction || secondaryActions) && (
            <div className="page-actions">
              <Space size={8}>
                {primaryAction}
                {secondaryActions && secondaryActions.length > 0 && (
                  <Dropdown menu={dropdownMenu} placement="bottomRight">
                    <button className="more-actions-btn">
                      更多操作
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" />
                      </svg>
                    </button>
                  </Dropdown>
                )}
              </Space>
            </div>
          )}
        </div>

        {/* 标签页 */}
        {tabs && <div className="page-tabs">{tabs}</div>}
      </div>

      {/* 内容区 */}
      <div className="page-content">{children}</div>
    </div>
  );
}
