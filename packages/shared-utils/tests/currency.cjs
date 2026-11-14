const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const code = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  },
).outputText;
const exportsObject = {};
new Function("exports", "require", code)(exportsObject, () => ({}));
const { formatMoney } = exportsObject;
const originalIntl = global.Intl;
const formatter = new originalIntl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
});
const values = [
  0,
  -0,
  0.005,
  -0.005,
  1.005,
  -1.005,
  100.005,
  999.995,
  -999.995,
  0.00000001,
  1e21,
  1e22,
  Number.MAX_VALUE,
  "610.08",
  "-123456.78",
  999999999999.99,
];
for (let i = 0; i < 3000; i++)
  values.push((((i * 7919) % 2000000) - 1000000) / 1000);
const expected = values.map((value) => formatter.format(Number(value)));
try {
  global.Intl = undefined;
  assert.deepEqual(values.map(formatMoney), expected);
  assert.equal(formatMoney("bad"), "¥0.00");
  global.Intl = {
    NumberFormat: function () {
      throw new Error("locale unavailable");
    },
  };
  assert.deepEqual(values.map(formatMoney), expected);
  global.Intl = {};
  assert.deepEqual(values.map(formatMoney), expected);
} finally {
  global.Intl = originalIntl;
}
assert.deepEqual(values.map(formatMoney), expected);
console.log(
  `Currency compatibility: ${values.length} values agree with Intl; missing, partial and unsupported locale engines passed.`,
);
