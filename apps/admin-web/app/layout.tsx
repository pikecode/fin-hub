import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";
import "antd/dist/reset.css";
import "./styles.css";

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
                colorText: "#171717",           // neutral-900
                colorTextSecondary: "#525252",  // neutral-600
                colorTextTertiary: "#737373",   // neutral-500
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
                fontSizeHeading1: 36,
                fontSizeHeading2: 30,
                fontSizeHeading3: 24,
                fontSizeHeading4: 20,
                fontSizeHeading5: 18,
                fontSizeLG: 16,
                fontSizeSM: 12,
                fontSizeXL: 18,
                // 间距系统（基于 4px）
                borderRadius: 6,
                borderRadiusLG: 12,
                borderRadiusSM: 4,
                borderRadiusXS: 2,
                fontFamily:
                  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
              },
              components: {
                Button: {
                  borderRadius: 6,
                  controlHeight: 40,
                  fontWeight: 600,
                  paddingContentHorizontal: 16,
                },
                Card: {
                  borderRadiusLG: 12,
                  paddingLG: 24,
                  headerHeight: 56,
                  boxShadowTertiary: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
                },
                Table: {
                  borderColor: "#e5e5e5",
                  headerBg: "#fafafa",
                  headerColor: "#171717",
                  rowHoverBg: "rgba(20, 184, 166, 0.06)",
                  fontWeightStrong: 600,
                  cellPaddingBlock: 16,
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
                  borderRadiusLG: 12,
                  headerBg: "#fafafa",
                },
                Input: {
                  controlHeight: 40,
                  borderRadius: 6,
                  paddingBlock: 10,
                  paddingInline: 12,
                },
                Select: {
                  controlHeight: 40,
                  borderRadius: 6,
                },
                DatePicker: {
                  controlHeight: 40,
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
                  labelColor: "#525252",
                  labelHeight: 24,
                  itemMarginBottom: 20,
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
