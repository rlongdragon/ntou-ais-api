// 開功能頁 → 查詢 → 點第一筆的「詳」（doEdit1_2）→ 需要時自動 ReQuery，存明細頁
// node --env-file=.env example/probe-detail.js out.html <loader path> <button>=<value> [field=value ...]
import { writeFileSync } from "node:fs";
import { AisClient, load, serializeForm } from "../dist/index.js";

const [out, path, ...sets] = process.argv.slice(2);
const client = new AisClient({ username: process.env.AIS_USER, password: process.env.AIS_PASS, log: (m) => console.error(m) });
const loader = await client.get(path, { referer: client.menuUrl });
const target = /mainFrame\.location\.href\s*=\s*(['"])(.+?)\1/i.exec(loader.text)?.[2];
const dataUrl = new URL(target, loader.url).href;
const page = await client.get(dataUrl, { referer: loader.url });
const form = serializeForm(load(page.text));
for (const s of sets) {
  const i = s.indexOf("=");
  form.set(s.slice(0, i), s.slice(i + 1));
}
const result = await client.get(dataUrl, { form, referer: dataUrl, timeoutMs: 70_000 });

const key = /doEdit1_2\(this,\s*(?:'|&#39;)([^'&]+)(?:'|&#39;),\s*(?:'|&#39;)(\w+)/.exec(result.text);
const view = /var\s+viewpage\s*=\s*"([^"]+)"/.exec(result.text)?.[1];
if (!key || !view) throw new Error("查詢結果沒有「詳」連結");
const detail = new URLSearchParams({ Mode: key[2].toUpperCase() });
const parts = key[1].split("|");
for (let i = 0; i < parts.length; i += 2) detail.set(parts[i], parts[i + 1] ?? "");
const detailUrl = new URL(view, dataUrl).href;
let res = await client.get(detailUrl, { form: detail, referer: dataUrl, timeoutMs: 70_000 });
console.error(`detail ${res.status} ${res.url} ${res.text.length}`);
if (res.text.includes("__doPostBack('ReQuery'") && !/<table[^>]*id="DataGrid"/.test(res.text)) {
  const again = serializeForm(load(res.text));
  again.set("__EVENTTARGET", "ReQuery");
  again.set("__EVENTARGUMENT", "");
  res = await client.get(detailUrl, { form: again, referer: detailUrl, timeoutMs: 70_000 });
  console.error(`requery ${res.status} ${res.url} ${res.text.length}`);
}
writeFileSync(out, res.text);
