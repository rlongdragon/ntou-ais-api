// 開功能頁後送一次查詢表單並存結果，用來研究查詢結果格式
// node --env-file=.env example/probe-query.js out.html <loader path> <button>=<value> [field=value ...]
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
const res = await client.get(dataUrl, { form, referer: dataUrl, timeoutMs: 70_000 });
writeFileSync(out, res.text);
console.error(`${res.status} ${res.url} ${res.text.length} chars -> ${out}`);
