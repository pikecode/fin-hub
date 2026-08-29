import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";
import "antd/dist/reset.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "fin-hub 后台管理",
  description: "蘑说财务管理系统后台管理端",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ConfigProvider
            theme={{
              token: {
                // 优化后的主色 - 更有活力的绿色
                colorPrimary: "#2a9d66",
                colorSuccess: "#059669",
                colorWarning: "#f59e0b",
                colorError: "#dc2626",
                colorInfo: "#0ea5e9",
                colorText: "#111827",
                colorTextSecondary: "#6b7280",
                // 更纯净的背景色
                colorBgLayout: "#f9fafb",
                colorBorder: "#e5e7eb",
                borderRadius: 6,
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
              },
              components: {
                Button: {
                  borderRadius: 6,
                  controlHeight: 36,
                  fontWeight: 600,
                },
                Card: {
                  borderRadiusLG: 12,
                  paddingLG: 24,
                  headerHeight: 52,
                  boxShadowTertiary: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
                },
                Table: {
                  borderColor: "#e5e7eb",
                  headerBg: "#f9fafb",
                  headerColor: "#374151",
                  rowHoverBg: "rgba(42, 157, 102, 0.06)",
                  fontWeightStrong: 700,
                },
                Menu: {
                  itemBorderRadius: 6,
                  darkItemBg: "#0f172a",
                  darkSubMenuItemBg: "#0f172a",
                  darkItemSelectedBg: "#2a9d66",
                  darkItemHoverBg: "rgba(255,255,255,0.08)",
                },
                Modal: {
                  borderRadiusLG: 12,
                },
                Input: {
                  controlHeight: 36,
                  borderRadius: 6,
                },
                Select: {
                  controlHeight: 36,
                  borderRadius: 6,
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
