import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import "antd/dist/reset.css";
import "./styles.css";

dayjs.locale("zh-cn");

export const metadata: Metadata = {
  title: "fin-hub 后台管理",
  description: "蘑说财务管理系统后台管理端",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ConfigProvider
            locale={zhCN}
            theme={{
              token: {
                // 企业级主色 - 青绿色（更高端专业）
                colorPrimary: "#14b8a6",
                colorPrimaryHover: "#0d9488",
                colorPrimaryActive: "#0f766e",
                colorSuccess: "#10b981",
                colorWarning: "#f59e0b",
                colorError: "#ef4444",
                colorInfo: "#3b82f6",
                // 精确的文字色彩层级
                colorText: "#111827",
                colorTextSecondary: "#4b5563",
                colorTextTertiary: "#6b7280",
                colorTextQuaternary: "#a3a3a3", // neutral-400
                // 纯净的背景色系统
                colorBgLayout: "#fafafa",       // neutral-50
                colorBgContainer: "#ffffff",
                colorBgElevated: "#ffffff",
                // 精确的边框色
                colorBorder: "#e5e5e5",         // neutral-200
                colorBorderSecondary: "#d4d4d4", // neutral-300
                // 字体系统
                fontSize: 14,
                fontSizeHeading1: 28,
                fontSizeHeading2: 24,
                fontSizeHeading3: 20,
                fontSizeHeading4: 18,
                fontSizeHeading5: 16,
                fontSizeLG: 16,
                fontSizeSM: 12,
                fontSizeXL: 18,
                // 间距系统（基于 4px）
                borderRadius: 6,
                borderRadiusLG: 12,
                borderRadiusSM: 4,
                borderRadiusXS: 2,
                fontFamily:
                  'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              },
              components: {
                Button: {
                  borderRadius: 6,
                  controlHeight: 34,
                  fontWeight: 600,
                  paddingContentHorizontal: 14,
                },
                Card: {
                  borderRadiusLG: 8,
                  paddingLG: 16,
                  headerHeight: 48,
                  boxShadowTertiary: "0 1px 2px rgba(15,23,42,0.04)",
                },
                Table: {
                  borderColor: "#e5e7eb",
                  headerBg: "#f8fafc",
                  headerColor: "#374151",
                  rowHoverBg: "#f8fafc",
                  fontWeightStrong: 600,
                  cellPaddingBlock: 10,
                  cellPaddingInline: 12,
                  cellFontSize: 14,
                },
                Menu: {
                  itemBorderRadius: 6,
                  darkItemBg: "#0f172a",
                  darkSubMenuItemBg: "#0f172a",
                  darkItemSelectedBg: "#14b8a6",
                  darkItemHoverBg: "rgba(255,255,255,0.08)",
                  itemHeight: 40,
                  itemMarginBlock: 4,
                  itemPaddingInline: 16,
                },
                Modal: {
                  borderRadiusLG: 8,
                  headerBg: "#ffffff",
                },
                Input: {
                  controlHeight: 34,
                  borderRadius: 6,
                  paddingBlock: 6,
                  paddingInline: 12,
                },
                Select: {
                  controlHeight: 34,
                  borderRadius: 6,
                },
                DatePicker: {
                  controlHeight: 34,
                  borderRadius: 6,
                },
                Dropdown: {
                  borderRadiusLG: 8,
                  boxShadowSecondary: "0 8px 24px rgba(0,0,0,0.12)",
                },
                Drawer: {
                  paddingLG: 24,
                },
                Form: {
                  labelFontSize: 14,
                  labelColor: "#4b5563",
                  labelHeight: 24,
                  itemMarginBottom: 16,
                },
              },
            }}
          >
            {children}
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
