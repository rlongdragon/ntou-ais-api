import * as cheerio from "cheerio";
import { AIS_BASE } from "./http.js";

export type Doc = cheerio.CheerioAPI;

export const load = (html: string): Doc => cheerio.load(html);

/** 去掉多餘空白，&nbsp; 視為空白 */
export const clean = (s: string | undefined) => (s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

/**
 * 依瀏覽器送出表單的規則收集欄位：略過 disabled、按鈕類 input、沒勾選的 checkbox/radio。
 * submit 按鈕不會包含在內，要送哪個按鈕由呼叫端自己 set。
 */
export function serializeForm($: Doc, form = "form"): URLSearchParams {
  const params = new URLSearchParams();
  const root = $(form).first();
  root.find("input[name], select[name], textarea[name]").each((_, el) => {
    const $el = $(el);
    if ($el.is("[disabled]")) return;
    const name = $el.attr("name")!;
    if (el.tagName === "select") {
      const selected = $el.find("option[selected]").first();
      const option = selected.length ? selected : $el.find("option").first();
      if (option.length) params.append(name, option.attr("value") ?? option.text());
      return;
    }
    if (el.tagName === "textarea") {
      params.append(name, $el.text());
      return;
    }
    const type = ($el.attr("type") ?? "text").toLowerCase();
    if (["submit", "button", "reset", "file", "image"].includes(type)) return;
    if ((type === "checkbox" || type === "radio") && !$el.is("[checked]")) return;
    params.append(name, $el.attr("value") ?? (type === "checkbox" || type === "radio" ? "on" : ""));
  });
  return params;
}

/** 頁面上用 JS 導向的目標（location.href = '...'），只接受 AIS 自己的網址 */
export function clientRedirect(html: string, base: string): string | undefined {
  const target =
    /(?:window\.|top\.|self\.)?location(?:\.href)?\s*=\s*(['"])(.*?)\1/i.exec(html)?.[2] ??
    /location\.replace\(\s*(['"])(.*?)\1\s*\)/i.exec(html)?.[2];
  if (!target) return undefined;
  try {
    const url = new URL(target.trim(), base);
    return url.origin === new URL(AIS_BASE).origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** 頁面中第一個 alert('...') 的內容 */
export function alertMessage(html: string): string | undefined {
  const m = /alert\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/s.exec(html)?.[2];
  return m?.replace(/\\n/g, "\n").replace(/\\(['"\\])/g, "$1").trim() || undefined;
}
