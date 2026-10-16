// 登入後直接開功能頁（loader → 資料頁），存 HTML 並列出表單欄位，用來研究頁面格式
// node --env-file=.env example/probe-pages.js .probe GRD7050=Application/GRD/GRD70/GRD7050_.aspx?progcd=STU2030 ...
import { mkdirSync, writeFileSync } from "node:fs";
import { AisClient, clientRedirect, load } from "../dist/index.js";

const [outDir, ...pages] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const client = new AisClient({
  username: process.env.AIS_USER,
  password: process.env.AIS_PASS,
  log: (m) => console.error(m),
});

for (const spec of pages) {
  const [name, path] = spec.split("=");
  const loader = await client.get(path, { referer: client.menuUrl });
  writeFileSync(`${outDir}/${name}-loader.html`, loader.text);
  const target = /(?:mainFrame|viewFrame)\.location\.href\s*=\s*(['"])(.+?)\1/i.exec(loader.text)?.[2];
  const dataUrl = target ? new URL(target, loader.url).href : clientRedirect(loader.text, loader.url);
  let page = loader;
  if (dataUrl && dataUrl !== loader.url) {
    page = await client.get(dataUrl, { referer: loader.url });
    writeFileSync(`${outDir}/${name}.html`, page.text);
  }
  const $ = load(page.text);
  console.log(`\n== ${name} ${page.status} ${page.url} (${page.text.length} chars)`);
  console.log("title:", $("title").text().trim());
  $("input[name], select[name], textarea[name]").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (/^__/.test(name)) return;
    const type = el.tagName === "input" ? $el.attr("type") ?? "text" : el.tagName;
    const extra =
      el.tagName === "select"
        ? $el.find("option").map((_, o) => `${$(o).attr("value")}${$(o).is("[selected]") ? "*" : ""}`).get().slice(0, 12).join(",")
        : ($el.attr("value") ?? "").slice(0, 40);
    console.log(`  ${type} ${name} = ${extra}`);
  });
  console.log("tables:", $("table[id]").map((_, t) => $(t).attr("id")).get().join(", "));
}
