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
    "pages/report-export/index",
  ],
  tabBar: {
    color: "#87928d",
    selectedColor: "#22634e",
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
        iconPath: "assets/tabbar/bank.png",
        selectedIconPath: "assets/tabbar/bank-active.png",
      },
      {
        pagePath: "pages/dividend/index",
        text: "分红管理",
        iconPath: "assets/tabbar/dividend.png",
        selectedIconPath: "assets/tabbar/dividend-active.png",
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
    navigationBarBackgroundColor: "#f4f6f7",
    navigationBarTitleText: "蘑说财务",
    navigationBarTextStyle: "black",
  },
});
