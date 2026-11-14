import Taro from "@tarojs/taro";
import { api, getShareholderToken } from "./api";

export async function restoreSavedSession(
  canContinue: () => boolean = () => true,
): Promise<boolean> {
  const token = getShareholderToken();
  if (!token) return false;
  // Let the server validate expiry, password changes, account state and permissions.
  await api.me();
  if (getShareholderToken() !== token || !canContinue()) return false;
  await Taro.switchTab({ url: "/pages/report/index" });
  return true;
}
