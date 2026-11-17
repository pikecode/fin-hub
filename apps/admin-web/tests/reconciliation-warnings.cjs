const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const out = {};
new Function(
  "exports",
  ts.transpileModule(
    fs.readFileSync(
      path.join(__dirname, "../app/lib/reconciliationWarnings.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText,
)(out);
const check = out.bankApprovalOverage;
assert.deepEqual(check(4920, 4920, 64286.67, 4467), {
  kind: "remaining",
  bank: 4920,
  approval: 4467,
  excess: 453,
});
assert.deepEqual(check(1000, 100, 500, 500), {
  kind: "total",
  bank: 1000,
  approval: 500,
  excess: 500,
});
assert.equal(check(4920, 4920, 64286.67, 4920), null);
assert.equal(check(100, 50, 100, 50), null);
assert.equal(check(0.1 + 0.2, 0.1 + 0.2, 0.3, 0.3), null);
assert.equal(check(100, 100, 100, 99.99).excess, 0.01);
assert.equal(check(NaN, 1, 1, 1), null);
console.log(
  "Overage warnings: cumulative 453, total-only excess, exact/partial amounts, cent boundaries and invalid values passed",
);
