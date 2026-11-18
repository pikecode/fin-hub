// Requires playwright-core on NODE_PATH; set CHROME_PATH to an installed Chrome executable.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: "var exports = {};" + ts.transpileModule(fs.readFileSync(path.join(__dirname, "../app/lib/compressVoucherImage.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText });
    const result = await page.evaluate(async () => {
      const compress = exports.compressVoucherImage;
      const small = new File(["small"], "keep.png", { type: "image/png" });
      if (await compress(small) !== small) throw Error("small original changed");
      const canvas = document.createElement("canvas"); canvas.width = 3000; canvas.height = 2000;
      const ctx = canvas.getContext("2d"); const data = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < data.data.length; i += 4) { data.data[i] = Math.random() * 256; data.data[i+1] = Math.random() * 256; data.data[i+2] = Math.random() * 256; data.data[i+3] = 255; }
      ctx.putImageData(data, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const output = await compress(new File([blob], "receipt.png", { type: "image/png" }));
      const bitmap = await createImageBitmap(output);
      let invalidRejected = false;
      try { await compress(new File([new Uint8Array(600000)], "bad.png", { type: "image/png" })); } catch { invalidRejected = true; }
      return { original: blob.size, size: output.size, type: output.type, name: output.name, width: bitmap.width, invalidRejected };
    });
    assert(result.original > 512000);
    assert(result.size > 0 && result.size <= 512000);
    assert.equal(result.type, "image/jpeg"); assert.equal(result.name, "receipt.jpg");
    assert(result.width <= 2400); assert(result.invalidRejected);
    console.log("Real browser image compression passed:", result);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
