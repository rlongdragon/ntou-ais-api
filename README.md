# ntou-ais-api

國立臺灣海洋大學教學務系統 AIS（`https://ais.ntou.edu.tw`）的非官方 Node.js client。用學號、密碼登入（驗證碼在本機自動辨識），查詢課表、成績、成績預警、缺曠、請假、獎懲與操行、獎助學金、抵免、畢業資格、開課資料與課綱。

> 本專案不是海大官方的工具，也未受其委託或背書。AIS 改版時部分功能可能暫時失效。請只用來查詢自己的資料，並避免高頻率存取學校的系統。

## 安裝

需要 Node.js 20 以上。

```bash
npm install github:rlongdragon/ntou-ais-api
```

驗證碼辨識用到 `onnxruntime-node` 與 `sharp` 兩個原生模組，安裝時會自動下載對應平台的二進位檔。

## 使用

```js
import { AisClient } from "ntou-ais-api";

const ais = new AisClient({
  username: process.env.AIS_USER, // 學號
  password: process.env.AIS_PASS,
  log: (m) => console.error(m),
});

const table = await ais.timetable(); // 目前學年期的課表
const { grades, totalCredits } = await ais.grades(); // 歷年成績
```

第一次呼叫任何查詢時會自動登入。

| 方法 | 說明 |
|---|---|
| `timetable(semester?)` | 個人選課清單與課表格子（星期、節次、時間、教室、課綱編號）。`semester` 例如 `"1151"`，預設為目前學年期 |
| `grades()` | 歷年成績、歷年累計學分與學籍資料；`status` 區分及格、不及格、成績未到、期中退選、抵免 |
| `absences()` | 本學期缺曠總節數與明細 |
| `conduct()` | 目前操行成績與獎懲紀錄 |
| `earlyWarnings()` | 本學期各科成績預警 |
| `leaves()` | 請假紀錄與各層審核狀態 |
| `scholarships(semester?)` | 某學年期的獎助學金申請紀錄，預設為目前學年期 |
| `creditTransfer()` | 抵免申請的審核結果；沒有申請過時 `applied` 為 `false` |
| `graduation()` | 畢業資格：各類應修學分、必修科目對照、學分統計表、教務處初審／複審結果 |
| `searchCourses({ keyword, by?, exact?, semester?, page?, pageSize? })` | 依課名、課號或教師查詢開課資料 |
| `syllabus(pkno)` | 課綱，`pkno` 來自 `timetable()` 的 `slots` |
| `syllabusByCode(code, { semester?, className? })` | 依課號（與班別）找課綱 |

沒有獨立方法的功能，可以用 `openProgram`、`submit`、`openDetail`、`parseGrid`、`readFields` 自己組合，選單結構可用 `Menu` 瀏覽（見 `example/explore-menu.js`）。

### 學年期

AIS 的學年期寫成學年加學期，例如 `1151` 是 115 學年度第 1 學期，`3`、`4` 是暑修。

### 畢業資格

`graduation()` 回傳的「已得學分」等欄位來自教務處的審查結果，還沒審查時都是 0，不代表實際修課進度。要估算進度，請用 `grades()` 對照必修科目表。

### 保存登入狀態

```js
const saved = await ais.exportSession(); // 內容等同登入憑證，請妥善保存
await other.importSession(saved);
```

匯入後不會先驗證；之後的請求發現 session 過期時會自動重新登入。

## 登入流程

AIS 沒有接學校的 CAS，只能走自己的登入表單，每次都要驗證碼：

1. `GET /Default.aspx`。沒有 session 時會先用 JS 導到排隊頁 `DefaultQ.aspx` 再導回來，這時頁面上才有驗證碼圖片。
2. 用同一個 session 下載驗證碼（4 碼英數），在本機用 ddddocr 的模型辨識。
3. 送出表單。成功時 AIS 仍回傳登入頁，只能從 `.ASPXAUTH` cookie 判斷；失敗原因在 `alert()` 裡。
4. 依序開啟 `MainFrame.aspx` 與 `MenuTree.aspx`。沒有載入過選單時，功能頁會被導回登入頁。

- 驗證碼錯誤會自動換一張重試，最多 5 次。
- 帳號或密碼錯誤**不會**重試，以免帳號被鎖；改好帳密後呼叫 `resetFailures()` 才會再次登入。
- 帳號在其他地方登入時，AIS 會要求先登出另一邊，這裡會自動登出後重新登入。

## 限制

- 一次只送一個請求，兩個請求之間至少間隔 300 ms（`minIntervalMs` 可調）。
- 成績明細、課表等頁面 AIS 回應較慢，單次查詢約需數秒。
- 缺曠、獎懲、獎助學金、抵免沒有紀錄時拿不到表頭，有紀錄時欄位依 AIS 原始表頭回傳；這幾項只測過沒有紀錄的帳號。
- 只測試過大學部學生帳號。

## 開發

```bash
npm install
npm run build
cp .env.example .env   # 填入 AIS_USER、AIS_PASS
node --env-file=.env example/example.js grades
```

`example/` 裡有研究頁面格式用的腳本：`explore-menu.js` 列出整棵選單，`probe-pages.js`、`probe-query.js`、`probe-detail.js` 存下頁面 HTML，`dump-tables.js` 把表格印成文字。

## 致謝

- 登入、選單與課表、成績、課程查詢的頁面流程參考 [lxuaneneliko/ntou-tat](https://github.com/lxuaneneliko/ntou-tat)（MIT）。
- 驗證碼模型 `models/common_old.onnx` 來自 [sml2h3/ddddocr](https://github.com/sml2h3/ddddocr)（MIT）。

## 授權

MIT。國立臺灣海洋大學的名稱與相關資料之權利屬各自權利人。
