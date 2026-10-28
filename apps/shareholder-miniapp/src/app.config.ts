export default defineAppConfig({
  pages: [
    "pages/shareholder-login/index",
    "pages/stores/index",
    "pages/report/index",
    "pages/profile/index",
    "pages/bank-detail/index",
    "pages/expenses/index",
  ],
  tabBar: {
    color: "#87928d",
    selectedColor: "#214f42",
    backgroundColor: "#ffffff",
    borderStyle: "white",
    list: [
      {
        pagePath: "pages/stores/index",
        text: "门店",
        iconPath: "assets/tabbar/stores.png",
        selectedIconPath: "assets/tabbar/stores-active.png",
      },
      {
        pagePath: "pages/report/index",
        text: "经营",
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
