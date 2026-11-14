const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const storage = new Map();
const calls = [];
const redirects = [];
const destinations = [];
const diagnosticLogs = [];
const modules = {};
const taro = {
  getStorageSync: (key) => storage.get(key) || "",
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  reLaunch: ({ url }) => redirects.push(url),
  switchTab: async ({ url }) => destinations.push(url),
  getRealtimeLogManager: () => ({
    warn: (...args) => diagnosticLogs.push(args),
  }),
  request: (options) =>
    new Promise((resolve, reject) =>
      calls.push({ ...options, resolve, reject }),
    ),
};
function load(name) {
  if (modules[name]) return modules[name];
  const source = fs.readFileSync(
    path.join(__dirname, "../src/lib", name + ".ts"),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "__API_BASE_URL__", code)(
    (name) => {
      if (name === "@tarojs/taro") return taro;
      if (["./navigation", "./diagnostics", "./api"].includes(name))
        return load(name.slice(2));
      throw new Error("Unexpected runtime dependency: " + name);
    },
    module,
    module.exports,
    "https://example.test",
  );
  modules[name] = module.exports;
  return module.exports;
}
const {
  request,
  setShareholderToken,
  getShareholderToken,
  clearShareholderToken,
} = load("api");
const ok = (call, value) =>
  call.resolve({ statusCode: 200, data: { data: value } });
async function run() {
  setShareholderToken("account-a");
  const start = calls.length;
  const all = Array.from({ length: 100 }, () =>
    request("/report?store_id=a&period=2026-10"),
  );
  assert.equal(calls.length, start + 1);
  ok(calls.at(-1), { amount: "610.08" });
  assert.equal((await Promise.all(all)).length, 100);
  const next = request("/report?store_id=a&period=2026-10");
  assert.equal(calls.length, start + 2);
  ok(calls.at(-1), { amount: "700" });
  assert.deepEqual(await next, { amount: "700" });
  const a = request("/report?store_id=a&period=2026-09"),
    b = request("/report?store_id=b&period=2026-10");
  assert.equal(calls.length, start + 4);
  ok(calls.at(-2), 1);
  ok(calls.at(-1), 2);
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  const failed = assert.rejects(request("/stores"), /failed/);
  calls.at(-1).resolve({ statusCode: 500, data: { detail: "failed" } });
  await failed;
  const retry = request("/stores");
  ok(calls.at(-1), []);
  assert.deepEqual(await retry, []);
  const network = assert.rejects(request("/network"), /超时/);
  calls.at(-1).reject(new Error("timeout"));
  await network;
  const networkRetry = request("/network");
  ok(calls.at(-1), true);
  assert.equal(await networkRetry, true);
  for (const status of [200, 401]) {
    const stale = assert.rejects(request("/old"), /登录状态已变化/);
    const oldCall = calls.at(-1);
    setShareholderToken("account-b-" + status);
    const fresh = request("/old"),
      freshCall = calls.at(-1);
    oldCall.resolve({
      statusCode: status,
      data: { data: "old-account-data", detail: "old expired" },
    });
    await stale;
    assert.equal(getShareholderToken(), "account-b-" + status);
    assert.equal(redirects.length, 0);
    ok(freshCall, { safe: true });
    assert.deepEqual(await fresh, { safe: true });
  }
  const p1 = request("/login", { username: "test" }),
    p2 = request("/login", { username: "test" });
  assert.equal(calls.at(-1).method, "POST");
  assert.notEqual(calls.at(-1), calls.at(-2));
  ok(calls.at(-2), 1);
  ok(calls.at(-1), 2);
  await Promise.all([p1, p2]);
  const expires = assert.rejects(request("/me"), /expired/);
  calls.at(-1).resolve({ statusCode: 401, data: { detail: "expired" } });
  await expires;
  assert.equal(getShareholderToken(), "");
  assert.equal(redirects.length, 1);
  clearShareholderToken();
  let { restoreSavedSession } = load("session");
  const initialCalls = calls.length;
  assert.equal(await restoreSavedSession(), false);
  assert.equal(calls.length, initialCalls);
  setShareholderToken("saved-account");
  // Simulate a fresh app process while retaining device storage.
  Object.keys(modules).forEach((key) => delete modules[key]);
  ({ restoreSavedSession } = load("session"));
  const coldApi = load("api");
  const resumed = restoreSavedSession();
  ok(calls.at(-1), { username: "saved" });
  assert.equal(await resumed, true);
  assert.equal(destinations.at(-1), "/pages/report/index");
  for (const reason of [
    "request:fail timeout",
    "url not in domain list",
    "ssl certificate error",
  ]) {
    const failedResume = assert.rejects(
      restoreSavedSession(),
      /超时|域名|安全连接/,
    );
    calls.at(-1).reject({ errMsg: reason });
    await failedResume;
    assert.equal(coldApi.getShareholderToken(), "saved-account");
  }
  const malformed = assert.rejects(
    coldApi.request("/bad-response"),
    /服务返回异常/,
  );
  calls.at(-1).resolve({ statusCode: 200, data: "unexpected html" });
  await malformed;
  const sensitive = assert.rejects(
    coldApi.request("/bank/12345678901234567890123456789012?secret=do-not-log"),
    /超时/,
  );
  calls.at(-1).reject({ errMsg: "timeout with do-not-log" });
  await sensitive;
  const logged = JSON.stringify(diagnosticLogs);
  assert(
    !logged.includes("do-not-log") &&
      !logged.includes("saved-account") &&
      !logged.includes("12345678901234567890123456789012"),
  );
  const invalid = assert.rejects(restoreSavedSession(), /expired/);
  calls.at(-1).resolve({ statusCode: 401, data: { detail: "expired" } });
  await invalid;
  assert.equal(coldApi.getShareholderToken(), "");
  console.log(
    "Request coalescing: concurrent reads, fresh reads, scope isolation, failures, sessions and POST checks passed.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
