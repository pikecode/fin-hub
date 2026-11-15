export function apiErrorMessage(payload: unknown, status: number): string {
  const detail = payload && typeof payload === "object" && "detail" in payload ? (payload as { detail: unknown }).detail : null;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const labels: Record<string, string> = { amount: "金额", accounting_period: "入账月份", bank_transaction_id: "银行流水", expense_item_id: "费用明细", period: "月份", category_l1: "一级分类", category_l2: "二级分类" };
    const messages = detail.map((item: { loc?: unknown[]; type?: string }) => {
      const field = item.loc?.filter(x => x !== "body" && x !== "query" && x !== "path").find(x => typeof x === "string");
      const label = typeof field === "string" ? labels[field] || "提交字段" : "提交字段";
      if (item.type === "greater_than" && field === "amount") return "金额必须大于0，请检查审批单剩余可匹配金额";
      if (item.type === "missing") return `请填写${label}`;
      return `${label}格式或取值不正确，请检查后重试`;
    });
    if (messages.length) return [...new Set(messages)].slice(0, 3).join("；");
  }
  return ({ 401: "登录已失效，请重新登录", 403: "没有操作权限，请联系管理员", 404: "记录不存在或已删除，请刷新后重试", 409: "记录状态已变化，请刷新后核对", 422: "提交内容不符合要求，请检查金额、入账月份及必填项" } as Record<number, string>)[status] || "请求失败，请稍后重试";
}
