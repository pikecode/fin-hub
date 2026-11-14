const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const calls = [];
let status = 200,
  failDownload = false,
  failPreview = false;
const taro = {
  downloadFile: async (options) => {
    calls.push(["download", options]);
    if (failDownload) throw { errMsg: "downloadFile:fail timeout" };
    return { statusCode: status, tempFilePath: "wxfile://tmp/voucher" };
  },
  previewImage: async (options) => {
    calls.push(["image", options]);
    if (failPreview) throw { errMsg: "previewImage:fail" };
  },
  openDocument: async (options) => {
    calls.push(["document", options]);
    if (failPreview) throw { errMsg: "openDocument:fail" };
  },
};
function load(name) {
  const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "../src/lib", name + ".ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (id) => {
      if (id === "@tarojs/taro") return taro;
      if (id === "./api")
        return {
          API_BASE_URL: "https://fin.moshuo.fun",
          getShareholderToken: () => "test-token",
        };
      if (id === "./diagnostics") return load("diagnostics");
      throw new Error(id);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const { previewAttachment } = load("attachments");
(async () => {
  for (const file_name of [
    "voucher.png",
    "voucher.JPG",
    "voucher.jpeg",
    "voucher.webp",
    "voucher.gif",
  ]) {
    calls.length = 0;
    await previewAttachment({ id: "example", file_name, content_type: null });
    assert.equal(calls[1][0], "image");
    assert.deepEqual(calls[1][1], {
      current: "wxfile://tmp/voucher",
      urls: ["wxfile://tmp/voucher"],
    });
    assert.equal(calls[0][1].header.authorization, "Bearer test-token");
    assert.equal(
      calls[0][1].url,
      "https://fin.moshuo.fun/api/miniapp/attachments/example",
    );
  }
  calls.length = 0;
  await previewAttachment({
    id: "example",
    file_name: "no-extension",
    content_type: "image/png",
  });
  assert.equal(calls[1][0], "image");
  calls.length = 0;
  await previewAttachment({
    id: "example",
    file_name: "voucher.PDF",
    content_type: null,
  });
  assert.equal(calls[1][0], "document");
  assert.equal(calls[1][1].fileType, "pdf");
  for (status of [401, 403, 404, 502]) {
    calls.length = 0;
    await assert.rejects(
      previewAttachment({ id: "example", file_name: "voucher.png" }),
      status === 401 ? /登录已失效/ : /凭证暂不可用/,
    );
    assert.equal(calls.length, 1);
  }
  status = 200;
  failDownload = true;
  await assert.rejects(
    previewAttachment({ id: "example", file_name: "voucher.png" }),
    /请求超时/,
  );
  failDownload = false;
  failPreview = true;
  await assert.rejects(
    previewAttachment({ id: "example", file_name: "voucher.png" }),
    /图片预览失败/,
  );
  await assert.rejects(
    previewAttachment({ id: "example", file_name: "voucher.pdf" }),
    /文档打开失败/,
  );
  console.log(
    "Attachment preview passed: missing MIME, image extensions, native paths, authenticated download, PDF, HTTP/network/native failures.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
