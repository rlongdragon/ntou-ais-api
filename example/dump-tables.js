// 把 HTML 裡有 id 的表格印成「欄位 | 欄位」文字，方便研究頁面格式
// node example/dump-tables.js page.html [maxRows]
import { readFileSync } from "node:fs";
import { clean, load } from "../dist/index.js";

const [file, max = "15"] = process.argv.slice(2);
const $ = load(readFileSync(file, "utf8"));
$("table[id]").each((_, t) => {
  const rows = $(t).children("tbody").length ? $(t).children("tbody").children("tr") : $(t).children("tr");
  console.log(`\n### table#${$(t).attr("id")} (${rows.length} rows)`);
  rows.slice(0, Number(max)).each((_, tr) => {
    const cells = $(tr)
      .children("td, th")
      .map((_, c) => {
        const span = [$(c).attr("rowspan") && `r${$(c).attr("rowspan")}`, $(c).attr("colspan") && `c${$(c).attr("colspan")}`]
          .filter(Boolean)
          .join("");
        return (span ? `[${span}]` : "") + clean($(c).text()).slice(0, 60);
      })
      .get();
    console.log("  " + cells.join(" | "));
  });
});
