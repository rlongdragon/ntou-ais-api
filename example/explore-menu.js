// 登入後展開整棵 AIS 選單，輸出每個功能的路徑與網址
// node --env-file=.env example/explore-menu.js > .probe/menu.txt
import { AisClient, Menu } from "../dist/index.js";

const client = new AisClient({
  username: process.env.AIS_USER,
  password: process.env.AIS_PASS,
  log: (m) => console.error(m),
});

const menu = await Menu.open(client);

async function walk(nodes, depth) {
  for (const node of nodes) {
    const pad = "  ".repeat(depth);
    if (node.kind === "page") {
      console.log(`${pad}- ${node.text}  ${node.url}`);
    } else {
      console.log(`${pad}+ ${node.text}`);
      await walk(await menu.expand(node), depth + 1);
    }
  }
}

await walk(menu.root, 0);
