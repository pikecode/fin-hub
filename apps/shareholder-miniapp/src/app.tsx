import Taro from "@tarojs/taro";
import { logIssue } from "./lib/diagnostics";
import { PropsWithChildren } from "react";
import "./app.css";

export default function App({ children }: PropsWithChildren) {
  Taro.useError((error) =>
    logIssue(
      /intl|numberformat/i.test(error)
        ? "FORMATTER_UNAVAILABLE"
        : "RUNTIME_ERROR",
    ),
  );
  return children;
}
