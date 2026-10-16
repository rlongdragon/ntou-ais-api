import type { AisClient } from "./client.js";
import { AisError } from "./http.js";
import { clean, load } from "./form.js";

// AIS 左側選單是 ASP.NET TreeView，子節點要用 client callback 展開。
// 做法參考 lxuaneneliko/ntou-tat 的 src/api/portalMenu.ts（MIT）。

export interface MenuNode {
  text: string;
  /** 群組節點可以展開；頁面節點有 url */
  kind: "group" | "page";
  url?: string;
  href: string;
}

interface TreeState {
  fields: Record<string, string>;
  lastIndex: number;
}

const unescapeJs = (s: string) =>
  s
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(['"\\])/g, "$1");

const pageOf = (href: string) => /([A-Za-z0-9_./-]+\.aspx(?:\?[^"' <>\s)]*)?)/i.exec(href)?.[1];

function parseNodes(html: string, base: string): MenuNode[] {
  const $ = load(html);
  const nodes: MenuNode[] = [];
  $("a[href]").each((_, a) => {
    const text = clean($(a).text());
    const href = $(a).attr("href") ?? "";
    if (!text) return;
    if (/TreeView_PopulateNode/i.test(href)) nodes.push({ text, kind: "group", href });
    else {
      const page = pageOf(href);
      if (page) nodes.push({ text, kind: "page", href, url: new URL(page, base).href });
    }
  });
  // 同一個節點常同時有圖示與文字兩個連結
  return nodes.filter((n, i) => nodes.findIndex((m) => m.text === n.text && m.kind === n.kind) === i);
}

function callbackParam(node: MenuNode, lastIndex: number) {
  const index = Number(/TreeView_PopulateNode\([^,]+,\s*(\d+)/i.exec(node.href)?.[1]);
  const values = [...node.href.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g)].map((m) =>
    unescapeJs(m[1] ?? m[2] ?? "")
  );
  const [, text, path, databound, datapath, parentIsLast] = values.slice(-6);
  if (!Number.isFinite(index) || !text || path === undefined) {
    throw new AisError(`AIS 選單節點格式已變更：${node.text}`, "MENU_CHANGED");
  }
  return {
    index,
    param: `${index}|${lastIndex}|${databound}f${parentIsLast}|${text.length}|${text}${datapath.length}|${datapath}${path}`,
  };
}

function parseCallback(raw: string) {
  if (raw.startsWith("e")) throw new AisError(raw.slice(1) || "AIS 選單展開失敗", "MENU_CALLBACK_FAILED");
  if (raw.startsWith("s")) return { validation: "", result: raw.slice(1) };
  if (raw.startsWith("<script")) throw new AisError("AIS 選單 session 已失效", "SESSION_EXPIRED");
  const sep = raw.indexOf("|");
  const len = Number(raw.slice(0, sep));
  if (sep < 0 || !Number.isFinite(len)) throw new AisError("AIS 選單回應格式已變更", "MENU_CHANGED");
  return { validation: raw.slice(sep + 1, sep + 1 + len), result: raw.slice(sep + 1 + len) };
}

/** 一棵選單樹的瀏覽狀態。展開節點時 ASP.NET 需要前面所有展開的紀錄，所以要用同一個 Menu 依序展開。 */
export class Menu {
  private constructor(
    private readonly client: AisClient,
    private readonly state: TreeState,
    readonly root: MenuNode[]
  ) {}

  static async open(client: AisClient): Promise<Menu> {
    const res = await client.get(client.menuUrl, { referer: client.mainFrameUrl });
    const $ = load(res.text);
    const fields: Record<string, string> = {};
    $("input[name]").each((_, el) => {
      fields[$(el).attr("name")!] = $(el).attr("value") ?? "";
    });
    const root = parseNodes(res.text, client.menuUrl);
    const lastIndex = Number(/Menu_TreeView_Data\.lastIndex\s*=\s*['"]?(\d+)/i.exec(res.text)?.[1]);
    return new Menu(client, { fields, lastIndex: Number.isFinite(lastIndex) ? lastIndex : root.length }, root);
  }

  /** 展開群組節點，回傳它的子節點 */
  async expand(node: MenuNode): Promise<MenuNode[]> {
    if (node.kind !== "group") throw new AisError(`「${node.text}」不是可以展開的選單`, "MENU_NOT_GROUP");
    const { index, param } = callbackParam(node, this.state.lastIndex);
    const form = new URLSearchParams(this.state.fields);
    form.set("__CALLBACKID", "Menu_TreeView");
    form.set("__CALLBACKPARAM", param);
    const res = await this.client.get(this.client.menuUrl, { form, referer: this.client.menuUrl, accept: "*/*" });
    const frame = parseCallback(res.text);
    const a = frame.result.indexOf("|");
    const b = frame.result.indexOf("|", a + 1);
    const next = Number(frame.result.slice(0, a));
    if (a < 0 || b < 0 || !Number.isFinite(next)) throw new AisError("AIS 選單內容格式已變更", "MENU_CHANGED");
    const f = this.state.fields;
    this.state.lastIndex = next;
    if (frame.validation) f.__EVENTVALIDATION = frame.validation;
    f.Menu_TreeView_ExpandState = (f.Menu_TreeView_ExpandState ?? "") + frame.result.slice(a + 1, b);
    f.Menu_TreeView_PopulateLog = (f.Menu_TreeView_PopulateLog ?? "") + `${index},`;
    return parseNodes(frame.result.slice(b + 1), this.client.menuUrl);
  }

  /** 依選單文字一路展開，回傳最後一層的節點；文字先找完全相同，再找包含 */
  async find(path: string[]): Promise<MenuNode> {
    let nodes = this.root;
    for (let i = 0; i < path.length; i++) {
      const label = path[i];
      const node = nodes.find((n) => n.text === label) ?? nodes.find((n) => n.text.includes(label));
      if (!node) throw new AisError(`AIS 選單找不到「${path.slice(0, i + 1).join(" > ")}」`, "MENU_NOT_FOUND");
      if (i === path.length - 1) return node;
      nodes = await this.expand(node);
    }
    throw new AisError("選單路徑不能是空的", "MENU_NOT_FOUND");
  }
}
