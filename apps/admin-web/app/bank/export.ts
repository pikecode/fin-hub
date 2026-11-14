import type { BankTransaction, Page } from "@fin-hub/shared-types";

export async function collectBankExport(
  list: (params: string) => Promise<Page<BankTransaction>>,
  filters: string,
): Promise<BankTransaction[]> {
  const params = new URLSearchParams(filters.replace(/^\?/, ""));
  params.set("page_size", "200");
  const rows: BankTransaction[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    params.set("page", String(page));
    const result = await list(`?${params}`);
    if (total !== undefined && total !== result.total) throw new Error("导出期间流水有变动，请重新导出");
    total = result.total;
    for (const item of result.items) {
      if (seen.has(item.id)) throw new Error("导出期间流水顺序有变动，请重新导出");
      seen.add(item.id);
      rows.push(item);
    }
    if (rows.length >= total) return rows;
    if (!result.items.length) throw new Error("流水读取不完整，请重新导出");
  }
}

export function bankExportCsv(rows: BankTransaction[], storeNames: Map<string, string>): string {
  const cell = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const data: unknown[][] = [["流水ID", "门店", "发生日期", "类型", "金额", "余额", "对方户名", "对方账号", "摘要", "银行流水号", "付款情况", "直接入账属性", "流水属性", "已匹配金额", "入账月份"]];
  const payment: Record<string, string> = { paid: "已实付", unpaid: "未实付", unreceived: "未实收" };
  const posting: Record<string, string> = { bank_interest: "银行结息", other_income: "其他收入", bank_fee: "银行手续费", bank_sms_fee: "银行短信费", bank_other_expense: "银行其他支出" };
  const special: Record<string, string> = { current_account: "往来款", shareholder_dividend: "股东分红", shareholder_capital: "股东注资", other_income_expense: "其他收支", counter_refund: "退款", loan_repayment: "借还款" };
  for (const row of rows) data.push([row.id, storeNames.get(row.store_id) || row.store_id, row.occurred_at.slice(0, 10), row.direction === "income" ? "收入" : "支出", row.amount, row.running_balance, row.counterparty_name, row.counterparty_account, row.summary, row.bank_serial_no, payment[row.payment_status] || row.payment_status, row.direct_posting_type ? posting[row.direct_posting_type] || row.direct_posting_type : "", row.special_type ? special[row.special_type] || row.special_type : "普通", row.matched_amount, row.accounting_periods?.join("、")]);
  return "\ufeff" + data.map(row => row.map(cell).join(",")).join("\r\n");
}
