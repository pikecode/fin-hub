export default defineAppConfig({
  pages: [
    "pages/shareholder-login/index",
    "pages/report/index",
    "pages/bank/index",
    "pages/dividend/index",
    "pages/profile/index",
    "pages/bank-detail/index",
    "pages/expenses/index",
    "pages/receipts/index",
  ],
  tabBar: {
    color: "#87928d",
    selectedColor: "#214f42",
    backgroundColor: "#ffffff",
    borderStyle: "white",
    list: [
      {
        pagePath: "pages/report/index",
        text: "报表",
        iconPath: "assets/tabbar/business.png",
        selectedIconPath: "assets/tabbar/business-active.png",
      },
      {
        pagePath: "pages/bank/index",
        text: "银行流水",
        iconPath: "assets/tabbar/stores.png",
        selectedIconPath: "assets/tabbar/stores-active.png",
      },
      {
        pagePath: "pages/dividend/index",
        text: "分红管理",
        iconPath: "assets/tabbar/business.png",
        selectedIconPath: "assets/tabbar/business-active.png",
      },
      {
        pagePath: "pages/profile/index",
        text: "我的",
        iconPath: "assets/tabbar/profile.png",
        selectedIconPath: "assets/tabbar/profile-active.png",
      },
    ],
  },
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#f5f5f1",
    navigationBarTitleText: "蘑说财务",
    navigationBarTextStyle: "black",
  },
});
