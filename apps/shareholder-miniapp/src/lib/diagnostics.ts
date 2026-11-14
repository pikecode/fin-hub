import Taro from "@tarojs/taro";

export type IssueKind =
  | "NETWORK_TIMEOUT"
  | "DOMAIN_NOT_ALLOWED"
  | "TLS_ERROR"
  | "NETWORK_FAILURE"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "FORMATTER_UNAVAILABLE"
  | "RUNTIME_ERROR";
export function networkIssue(error: unknown): {
  kind: IssueKind;
  message: string;
} {
  const text = String(
    (error as { errMsg?: string; message?: string })?.errMsg ||
      (error as { message?: string })?.message ||
      "",
  ).toLowerCase();
  if (/timeout|timed out/.test(text))
    return { kind: "NETWORK_TIMEOUT", message: "请求超时，请检查网络后重试" };
  if (/domain|合法域名|url not/.test(text))
    return {
      kind: "DOMAIN_NOT_ALLOWED",
      message: "请求域名未通过微信校验，请联系管理员检查小程序配置",
    };
  if (/ssl|tls|certificate/.test(text))
    return {
      kind: "TLS_ERROR",
      message: "安全连接失败，请检查手机时间、微信版本或更换网络重试",
    };
  return { kind: "NETWORK_FAILURE", message: "网络连接失败，请检查网络后重试" };
}
export function logIssue(
  kind: IssueKind,
  context: { path?: string; status?: number; durationMs?: number } = {},
) {
  // Never record query strings, request/response bodies, tokens or raw error text.
  const safe = {
    build: "20261114-session-android-01",
    kind,
    path: context.path
      ?.split("?")[0]
      .replace(/\/[a-f0-9-]{32,36}(?=\/|$)/gi, "/:id"),
    status: context.status,
    durationMs: context.durationMs,
  };
  try {
    const logger =
      typeof Taro.getRealtimeLogManager === "function"
        ? Taro.getRealtimeLogManager()
        : null;
    logger?.warn("miniapp-diagnostic", safe);
  } catch {
    /* Diagnostic availability must not interrupt data loading. */
  }
}
