import { defineConfig } from "@tarojs/cli";

const apiBaseUrl = process.env.TARO_APP_API_BASE_URL ?? "http://localhost:8000";

export default defineConfig({
  projectName: "fin-hub-shareholder-miniapp",
  date: "2026-08-28",
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
  },
  sourceRoot: "src",
  outputRoot: "dist",
  framework: "react",
  compiler: "webpack5",
  defineConstants: {
    __API_BASE_URL__: JSON.stringify(apiBaseUrl),
  },
  mini: {},
  h5: {},
});
