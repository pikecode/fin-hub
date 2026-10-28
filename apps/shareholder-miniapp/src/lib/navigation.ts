import Taro from "@tarojs/taro";
const STORE_KEY = "fin_hub_selected_store";
const PERIOD_KEY = "fin_hub_selected_periods";
export const selectedStore = () => Taro.getStorageSync<string>(STORE_KEY) || "";
export const selectStore = (id: string) => Taro.setStorageSync(STORE_KEY, id);
export const selectedPeriod = (id: string) =>
  (Taro.getStorageSync<Record<string, string>>(PERIOD_KEY) || {})[id] || "";
export function selectPeriod(id: string, period: string) {
  Taro.setStorageSync(PERIOD_KEY, {
    ...(Taro.getStorageSync<Record<string, string>>(PERIOD_KEY) || {}),
    [id]: period,
  });
}
export function clearNavigation() {
  Taro.removeStorageSync(STORE_KEY);
  Taro.removeStorageSync(PERIOD_KEY);
}
