import type { AisClient } from "./client.js";
import { AisError } from "./http.js";
import { alertMessage, clean, load, serializeForm, type Doc } from "./form.js";

/** 一個已載入的 AIS 頁面 */
export interface Page {
  url: string;
  html: string;
  $: Doc;
}

const toPage = (url: string, html: string): Page => ({ url, html, $: load(html) });

/**
 * 開啟功能頁。選單上的網址（例如 GRD5010_.aspx?progcd=...）只是 loader，
 * 會用 JS 把 mainFrame 導到真正的資料頁（GRD5010_01.aspx），這裡會跟過去。
 */
export async function openProgram(client: AisClient, path: string): Promise<Page> {
  const loader = await client.get(path, { referer: client.menuUrl });
  const target = /(?:mainFrame|viewFrame)\.location\.href\s*=\s*(['"])([^'"]+\.aspx(?:\?[^'"]*)?)\1/i.exec(loader.text)?.[2];
  let page = loader;
  if (target) page = await client.get(new URL(target, loader.url).href, { referer: loader.url });
  // 功能頁一定有 WebForms 表單；沒有的話多半是錯誤頁或被防火牆擋下，不要當成「沒有資料」
  if (!/<form\b/i.test(page.text)) {
    const message = alertMessage(page.text);
    throw new AisError(`AIS 回傳了非預期的頁面${message ? `：${message}` : ""}（${new URL(page.url).pathname}）`, "UNEXPECTED_PAGE");
  }
  return toPage(page.url, page.text);
}

/**
 * 送出頁面上的表單（等同按下某個按鈕）。fields 會覆蓋表單原本的值，
 * 按鈕本身也要放在 fields 裡，例如 { QUERY_BTN1: "查詢" }。
 */
export async function submit(
  client: AisClient,
  page: Page,
  fields: Record<string, string>,
  opts: { timeoutMs?: number } = {}
): Promise<Page> {
  const form = serializeForm(page.$);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const action = new URL(page.$("form").first().attr("action") ?? page.url, page.url).href;
  const res = await client.get(action, { form, referer: page.url, timeoutMs: opts.timeoutMs ?? 60_000 });
  return toPage(res.url, res.text);
}

/**
 * 點查詢結果的「詳」（doEdit1_2），開啟明細頁。
 * 明細頁有時要再 postback 一次（ReQuery）才會帶出資料表。
 */
export async function openDetail(client: AisClient, page: Page, index = 0): Promise<Page> {
  const calls = [
    ...page.html.matchAll(/doEdit1_2\(this,\s*(?:'|&#39;)([^'&]*)(?:'|&#39;),\s*(?:'|&#39;)(\w+)(?:'|&#39;)\)/g),
  ];
  const call = calls[index];
  const view = /var\s+viewpage\s*=\s*"([^"]+)"/.exec(page.html)?.[1];
  if (!call || !view) throw new AisError("查詢結果沒有可以開啟的明細", "NO_DETAIL");

  const form = new URLSearchParams({ Mode: call[2].toUpperCase() });
  const keys = call[1].split("|");
  for (let i = 0; i + 1 < keys.length; i += 2) form.set(keys[i], keys[i + 1]);
  const url = new URL(view, page.url).href;
  let res = await client.get(url, { form, referer: page.url, timeoutMs: 60_000 });

  if (res.text.includes("__doPostBack('ReQuery'") && !/<table[^>]*\bid="DataGrid"/.test(res.text)) {
    const again = serializeForm(load(res.text));
    again.set("__EVENTTARGET", "ReQuery");
    again.set("__EVENTARGUMENT", "");
    res = await client.get(url, { form: again, referer: url, timeoutMs: 90_000 });
  }
  return toPage(res.url, res.text);
}

/** 保留換行的 clean：每行各自去掉多餘空白，去掉空行（課綱等長文字用 \n 換行） */
const cleanLines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => clean(l))
    .filter(Boolean)
    .join("\n");

/** 讀頁面上帶 CNAME 屬性的欄位（AIS 用 CNAME 標示欄位的中文名稱），回傳 { 中文名稱: 值 } */
export function readFields($: Doc): Record<string, string> {
  const out: Record<string, string> = {};
  $("[cname]").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("cname")!;
    let value: string;
    if (el.tagName === "input") value = $el.attr("value") ?? "";
    else if (el.tagName === "select") value = clean($el.find("option[selected]").text());
    else value = cleanLines($el.text());
    if (value && !(name in out)) out[name] = value;
  });
  return out;
}

/** 表格的直接子列（不含巢狀表格的列） */
export function rowsOf($: Doc, table: ReturnType<Doc>) {
  const body = table.children("tbody");
  return (body.length ? body : table).children("tr").toArray().map((tr) => $(tr).children("td, th").toArray());
}

export interface Grid {
  columns: string[];
  rows: Record<string, string>[];
}

const EMPTY = /查無符合資料|There is no matching data/;

/**
 * 解析 DataGrid：第一列是表頭，其餘每列轉成 { 表頭: 值 }。
 * 表頭重複時第二個起加上序號（例如「學分」「學分_2」）。只有「查無符合資料」時回傳空的 rows。
 */
export function parseGrid($: Doc, selector = "#DataGrid"): Grid {
  const table = $(selector).first();
  if (!table.length) return { columns: [], rows: [] };
  const rows = rowsOf($, table);
  if (!rows.length || (rows.length === 1 && EMPTY.test(clean($(rows[0]).text())))) return { columns: [], rows: [] };

  const seen = new Map<string, number>();
  const columns = rows[0].map((c, i) => {
    const name = clean($(c).text()) || `欄${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}_${n}`;
  });
  const out = rows.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    cells.forEach((c, i) => {
      // 「詳」「編」之類的操作按鈕欄沒有表頭，略過
      if (!rows[0][i] || !clean($(rows[0][i]).text())) return;
      row[columns[i]] = clean($(c).text());
    });
    return row;
  });
  return { columns: columns.filter((_, i) => clean($(rows[0][i]).text())), rows: out.filter((r) => Object.values(r).some(Boolean)) };
}

/** 分頁資訊（#PC_TotalRow 等） */
export function readPaging($: Doc) {
  const num = (id: string) => {
    const el = $(`#${id}`);
    const n = Number(clean(el.attr("value") ?? el.text()));
    return Number.isFinite(n) ? n : undefined;
  };
  return { page: num("PC_PageNo"), totalPages: num("PC_TotalPage"), totalRows: num("PC_TotalRow") };
}
