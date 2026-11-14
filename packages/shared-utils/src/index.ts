export function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return year && month ? `${year}年${month}月` : period;
}

function fallbackMoney(numeric: number): string {
  const negative = numeric < 0 || Object.is(numeric, -0);
  const [coefficient, exponentText] = Math.abs(numeric)
    .toString()
    .toLowerCase()
    .split("e");
  const dot = coefficient.indexOf(".");
  const digits = coefficient.replace(".", "");
  const point =
    (dot < 0 ? coefficient.length : dot) + Number(exponentText || 0);
  const zeros = (count: number) => new Array(Math.max(0, count) + 1).join("0");
  const integer =
    point <= 0 ? "0" : digits.slice(0, point) + zeros(point - digits.length);
  const fraction =
    (point < 0 ? zeros(-point) + digits : digits.slice(Math.max(0, point))) +
    "000";
  let cents = (integer + fraction.slice(0, 2)).split("");
  if (fraction.charAt(2) >= "5") {
    let index = cents.length - 1;
    while (index >= 0 && cents[index] === "9") {
      cents[index] = "0";
      index--;
    }
    if (index < 0) cents.unshift("1");
    else cents[index] = String(Number(cents[index]) + 1);
  }
  const whole = cents
    .slice(0, -2)
    .join("")
    .replace(/^0+(?=\d)/, "");
  return (
    (negative ? "-" : "") +
    "¥" +
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    "." +
    cents.slice(-2).join("")
  );
}

let currencyConstructor: typeof Intl.NumberFormat | undefined;
let currencyFormatter: Intl.NumberFormat | null = null;

export function formatMoney(value: number | string): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "¥0.00";
  // Some miniapp JS engines lack Intl or the requested locale. Never let display
  // formatting prevent a financial page from rendering; preserve cent rounding.
  try {
    const constructor =
      typeof Intl === "undefined" ? undefined : Intl?.NumberFormat;
    if (constructor !== currencyConstructor) {
      currencyConstructor = constructor;
      currencyFormatter = null;
      if (typeof constructor === "function")
        currencyFormatter = new constructor("zh-CN", {
          style: "currency",
          currency: "CNY",
        });
    }
    if (currencyFormatter) return currencyFormatter.format(numeric);
  } catch {
    currencyFormatter = null;
  }
  return fallbackMoney(numeric);
}

export * from "./financialReport";
