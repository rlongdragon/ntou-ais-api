import type { AisClient } from "./client.js";
import { AisError } from "./http.js";
import { clean, load, type Doc } from "./form.js";
import { openDetail, openProgram, parseGrid, readFields, readPaging, rowsOf, submit, type Grid } from "./page.js";

// 各功能的 loader 網址（來自 AIS 選單）
export const PROGRAMS = {
  timetable: "Application/TKE/TKE22/TKE2240_.aspx?progcd=STU1220",
  grades: "Application/GRD/GRD50/GRD5010_.aspx?progcd=STU2020",
  absences: "Application/GRD/GRD70/GRD7050_.aspx?progcd=STU2030",
  conduct: "Application/SRP/SRP10/SRP1010_.aspx?progcd=SRP1010",
  graduation: "Application/ENR/ENRG0/ENRG010_.aspx?progcd=ENRG010",
  courseSearch: "Application/TKE/TKE22/TKE2210_.aspx?progcd=STU1190",
  syllabus: "Application/TKE/TKE22/TKE2240_03.aspx",
} as const;

/** 學年期，AIS 的寫法是學年加學期，例如 "1151" 是 115 學年度第 1 學期；3、4 是暑修 */
export type Semester = string;

function splitSemester(s: Semester) {
  const m = /^(\d{2,3})([1-4])$/.exec(s.trim());
  if (!m) throw new AisError(`學年期格式應為學年加學期，例如 1151：${s}`, "BAD_ARGUMENT");
  return { year: m[1], term: m[2] };
}

const selected = ($: Doc, name: string) => {
  const sel = $(`select[name="${name}"]`);
  const opt = sel.find("option[selected]").first();
  return (opt.length ? opt : sel.find("option").first()).attr("value") ?? "";
};

const cellText = ($: Doc, cell: Parameters<Doc>[0]) => clean($(cell).text());

// ── 課表 ──────────────────────────────────────────────

export interface TimetableCourse {
  code: string;
  title: string;
  department: string;
  class: string;
  teacher: string;
  credits: number | null;
  type: string;
  term: string;
}

export interface TimetableSlot {
  /** 1 = 星期一 … 7 = 星期日 */
  day: number;
  /** 節次標籤，例如「第二節」；第0節為早上 06:20 */
  period: string;
  start: string;
  end: string;
  title: string;
  code: string;
  department: string;
  class: string;
  room: string;
  /** 課綱編號，用 syllabus() 查詢 */
  pkno?: string;
}

export interface Timetable {
  semester: Semester;
  courses: TimetableCourse[];
  slots: TimetableSlot[];
}

const DAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

export async function timetable(client: AisClient, semester?: Semester): Promise<Timetable> {
  const page = await openProgram(client, PROGRAMS.timetable);
  const { year, term } = semester
    ? splitSemester(semester)
    : { year: selected(page.$, "Q_AYEAR"), term: selected(page.$, "Q_SMS") };
  const base = { Q_AYEAR: year, Q_SMS: term, "PC$PageSize": "200", "PC2$PageSize": "200" };

  // 選課清單與課表是兩個按鈕，都要從同一份查詢頁送出
  const list = await submit(client, page, { ...base, QUERY_BTN1: "選課清單" });
  const grid = await submit(client, page, { ...base, QUERY_BTN3: "選課課表" });

  const courses = parseGrid(list.$).rows.map((r) => ({
    code: r["課號"] ?? "",
    title: r["課名"] ?? "",
    department: r["開課單位"] ?? "",
    class: r["年級班別"] ?? "",
    teacher: r["授課老師"] ?? "",
    credits: r["學分"] ? Number(r["學分"]) : null,
    type: r["選別"] ?? "",
    term: r["期限"] ?? "",
  }));

  const slots: TimetableSlot[] = [];
  const $ = grid.$;
  const table = $("#table2").first();
  const rows = table.length ? rowsOf($, table) : [];
  const header = rows[0]?.map((c) => cellText($, c)) ?? [];
  for (const cells of rows.slice(1)) {
    const label = $(cells[0]).html()?.split(/<br\s*\/?>/i).map((s) => clean(load$(s))).filter(Boolean) ?? [];
    const [period = "", start = "", , end = ""] = label;
    cells.slice(1).forEach((cell, i) => {
      const day = DAYS.indexOf(header[i + 1]) + 1;
      if (day <= 0) return;
      $(cell)
        .find("a")
        .each((_, a) => {
          const parts = ($(a).html() ?? "").split(/<br\s*\/?>/i).map((s) => clean(load$(s)));
          const [title = "", code = "", department = "", cls = "", room = ""] = parts;
          const pkno = /fn_open\((?:&quot;|["'])(\d+)/.exec($(a).attr("href") ?? "")?.[1];
          slots.push({ day, period, start, end, title, code, department, class: cls, room, pkno });
        });
    });
  }
  return { semester: `${year}${term}`, courses, slots };
}

// cheerio 片段轉純文字（課表格子用 <br> 分隔欄位）
const load$ = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

// ── 成績 ──────────────────────────────────────────────

export interface Grade {
  semester: Semester;
  code: string;
  class: string;
  credits: number | null;
  /** 必修、選修、通識… */
  type: string;
  title: string;
  teacher: string;
  /** 數字成績；成績未到、期中退選、抵免等為 null */
  score: number | null;
  /** AIS 上原始的成績文字 */
  scoreText: string;
  /** passed 不及格標 *，pending 成績未到 +，withdrawn 期中退選 W，credited 抵免 */
  status: "passed" | "failed" | "pending" | "withdrawn" | "credited" | "unknown";
}

export interface Grades {
  student: Record<string, string>;
  /** 歷年累計學分（含暑修及抵免） */
  totalCredits: number | null;
  grades: Grade[];
}

function gradeStatus(text: string, score: number | null): Grade["status"] {
  if (/[*＊]/.test(text)) return "failed";
  if (/[+＋]/.test(text)) return "pending";
  if (/^W$/i.test(text)) return "withdrawn";
  if (/抵/.test(text)) return "credited";
  if (score !== null) return score >= 60 ? "passed" : "failed";
  if (/通過/.test(text)) return /未通過|不通過/.test(text) ? "failed" : "passed";
  return "unknown";
}

/** 歷年成績（全部學期） */
export async function grades(client: AisClient): Promise<Grades> {
  const page = await openProgram(client, PROGRAMS.grades);
  const result = await submit(client, page, { QUERY_TYPE: "RB_TYPE_3", QUERY_BTN1: "查詢" });
  const detail = await openDetail(client, result);
  const fields = readFields(detail.$);
  const list = parseGrid(detail.$).rows.map((r): Grade => {
    const scoreText = r["學期總成績"] ?? "";
    const n = /\d+(?:\.\d+)?/.exec(scoreText)?.[0];
    const score = n !== undefined && !/[+＋]/.test(scoreText) ? Number(n) : null;
    return {
      semester: r["學年期"] ?? "",
      code: r["課號"] ?? "",
      class: r["開課班別"] ?? "",
      credits: r["學分數"] ? Number(r["學分數"]) : null,
      type: r["選別"] ?? "",
      title: r["課程名稱"] ?? "",
      teacher: r["教師姓名"] ?? "",
      score,
      scoreText,
      status: gradeStatus(scoreText, score),
    };
  });
  const { 學分: crd, ...student } = fields;
  return { student, totalCredits: crd ? Number(crd) : null, grades: list };
}

// ── 缺曠 ──────────────────────────────────────────────

export interface Absences {
  semester: Semester;
  /** 目前缺曠課總節數 */
  totalPeriods: number | null;
  /** 明細，欄位依 AIS 原始表頭 */
  records: Grid;
}

/** 本學期缺曠紀錄 */
export async function absences(client: AisClient): Promise<Absences> {
  const page = await openProgram(client, PROGRAMS.absences);
  const result = await submit(client, page, { QUERY_BTN1: "查詢" });
  const summary = parseGrid(result.$).rows[0];
  const semester = readFields(result.$)["目前學年期"] ?? "";
  if (!summary) return { semester, totalPeriods: null, records: { columns: [], rows: [] } };
  const total = summary["目前缺曠課總節數"];
  const detail = await openDetail(client, result);
  return { semester, totalPeriods: total ? Number(total) : null, records: parseGrid(detail.$) };
}

// ── 獎懲與操行 ────────────────────────────────────────

export interface Conduct {
  /** 目前操行成績 */
  conductScore: number | null;
  /** 獎懲紀錄，欄位依 AIS 原始表頭 */
  records: Grid;
}

export async function conduct(client: AisClient): Promise<Conduct> {
  const page = await openProgram(client, PROGRAMS.conduct);
  const score = readFields(page.$)["目前操行成績"];
  return { conductScore: score ? Number(score) : null, records: parseGrid(page.$) };
}

// ── 畢業資格 ──────────────────────────────────────────

export interface GraduationCourse {
  /** 必修科目表上的學期（一上、一下…）、科目與學分 */
  term: string;
  course: string;
  credits: number | null;
  /** 對應到的已修課程；還沒修或還沒審查時為 undefined */
  taken?: { semester: string; title: string; type: string; department: string; score: string; credits: number | null };
  auditResult: string;
  reviewNote: string;
}

export interface CreditRow {
  /** 例如「共同教育課程」「選修 > 其他原修課程(本系)」「畢業最低學分數」 */
  item: string;
  required: string;
  earned: string;
  inProgress: string;
  total: string;
  missingCredits: string;
  missingCourses: string;
}

export interface Graduation {
  student: Record<string, string>;
  /** 各類科目應修學分 */
  requirements: { category: string; credits: number | null }[];
  /** 各類別的必修科目；summary 例如「總計課程：0 學分 承認課程：0 學分」 */
  categories: { name: string; summary: string; courses: GraduationCourse[] }[];
  credits: CreditRow[];
  /** 教務處初審、複審結果，還沒審查時是空字串 */
  firstReview: string;
  secondReview: string;
}

const num = (s: string | undefined) => (s && /^\d+(\.\d+)?$/.test(s) ? Number(s) : null);

export async function graduation(client: AisClient): Promise<Graduation> {
  const page = await openProgram(client, PROGRAMS.graduation);
  const $ = page.$;
  const fields = readFields($);

  const requirements = parseGrid($, "#DataGrid").rows.map((r) => ({
    category: r["科目類別"] ?? "",
    credits: num(r["應修學分"]),
  }));

  const categories: Graduation["categories"] = [];
  const list = $("#DataList").first();
  for (const [cell] of list.length ? rowsOf($, list) : []) {
    if (!cell) continue;
    const $cell = $(cell);
    const nested = $cell.find("table[id$=_DataGrid_FIELD]").first();
    const name = clean($cell.find("span[id$=_CRS_TYPE_NAME]").first().text());
    const summary = [
      clean($cell.find("span[id$=_TOTAL_CRD]").first().text()),
      clean($cell.find("span[id$=_TOTAL_REC_CRD]").first().text()),
    ]
      .filter(Boolean)
      .join(" ");
    const courses: GraduationCourse[] = [];
    if (nested.length) {
      for (const cells of rowsOf($, nested).slice(1)) {
        const t = cells.map((c) => cellText($, c));
        // 欄位：修課學年期 原修課程名稱 選課別 學年別 開課單位 成績 學分 | 學期 必修課目 學分 | 審核結果 複審備註
        const taken = t[0] || t[1]
          ? { semester: t[0], title: t[1], type: t[2], department: t[4], score: t[5], credits: num(t[6]) }
          : undefined;
        courses.push({ term: t[7] ?? "", course: t[8] ?? "", credits: num(t[9]), taken, auditResult: t[10] ?? "", reviewNote: t[11] ?? "" });
      }
    }
    if (name) categories.push({ name, summary, courses });
  }

  const credits: CreditRow[] = [];
  const crd = $("#DataGrid_CRD").first();
  let group = "";
  let groupLeft = 0;
  for (const cells of crd.length ? rowsOf($, crd).slice(1) : []) {
    const t = cells.map((c) => cellText($, c));
    let label: string;
    let values: string[];
    const span = Number($(cells[0]).attr("rowspan") ?? 1);
    if (span > 1) {
      group = t[0];
      groupLeft = span - 1;
      label = `${group} > ${t[1]}`;
      values = t.slice(2);
    } else if (groupLeft > 0) {
      groupLeft--;
      label = `${group} > ${t[0]}`;
      values = t.slice(1);
    } else {
      label = t[0];
      values = t.slice(1);
    }
    const [required = "", earned = "", inProgress = "", total = "", missingCredits = "", missingCourses = ""] = values;
    credits.push({ item: label, required, earned, inProgress, total, missingCredits, missingCourses });
  }

  const { 初審審核結果: firstReview = "", 複審審核結果: secondReview = "", ...student } = fields;
  return { student, requirements, categories, credits, firstReview, secondReview };
}

// ── 課程查詢 ──────────────────────────────────────────

export interface CourseSearchQuery {
  keyword: string;
  /** 依課名（預設）、課號或授課教師查詢 */
  by?: "title" | "code" | "teacher";
  /** 完全相符，預設 false（模糊比對） */
  exact?: boolean;
  /** 預設為目前學年期 */
  semester?: Semester;
  page?: number;
  pageSize?: number;
}

export interface CourseOffering {
  semester: Semester;
  code: string;
  title: string;
  department: string;
  class: string;
  teacher: string;
  teacherDepartment: string;
  allEnglish: string;
  credits: number | null;
  type: string;
  enrolled: number | null;
  limit: string;
  hours: number | null;
  term: string;
}

export interface CourseSearchResult {
  semester: Semester;
  page: number;
  totalPages: number;
  totalRows: number;
  courses: CourseOffering[];
}

async function runSearch(client: AisClient, q: CourseSearchQuery) {
  if (!q.keyword.trim()) throw new AisError("請提供查詢關鍵字", "BAD_ARGUMENT");
  let page = await openProgram(client, PROGRAMS.courseSearch);
  const current = page.$('input[name="Q_AYEARSMS"]').attr("value") ?? "";
  const { year, term } = splitSemester(q.semester ?? current);
  const size = String(Math.min(Math.max(q.pageSize ?? 30, 1), 200));
  const want = Math.max(q.page ?? 1, 1);
  const base = {
    Q_AYEAR: year.padStart(3, "0"),
    Q_SMS: term,
    Q_CH_LESSON: q.keyword.trim(),
    radioButtonClass: { code: "0", title: "1", teacher: "2" }[q.by ?? "title"],
    radioButtonQuery: q.exact ? "0" : "1",
    hdnSelectedTab: "1",
    QUERY_TYPE: "2",
    "PC$PageSize": size,
    "PC2$PageSize": size,
  };
  page = await submit(client, page, { ...base, QUERY_BTN7: "查詢" });
  if (want > 1) {
    // 換頁要用上一頁的回應（VIEWSTATE 帶著查詢結果）再 postback
    page = await submit(client, page, {
      ...base,
      "PC$PageNo": String(want),
      "PC2$PageNo": String(want),
      ActivePageControl: "PC",
      __EVENTTARGET: "ReQuery",
      __EVENTARGUMENT: "",
    });
  }
  const $ = page.$;
  // 課號連結是 __doPostBack('DataGrid$ctlNN$COSID')，postback 後才拿得到課綱編號
  const targets = $("#DataGrid tr")
    .slice(1)
    .map((_, tr) => /__doPostBack\((?:'|&#39;)(DataGrid\$ctl\d+\$COSID)/.exec($(tr).html() ?? "")?.[1] ?? "")
    .get();
  const courses = parseGrid($).rows.map((r): CourseOffering => ({
    semester: r["學期"] ?? "",
    code: r["課號"] ?? "",
    title: r["課名"] ?? "",
    department: r["開課單位"] ?? "",
    class: r["年級班別"] ?? "",
    teacher: r["授課老師"] ?? "",
    teacherDepartment: r["老師單位"] ?? "",
    allEnglish: r["全程英語"] ?? "",
    credits: num(r["學分"]),
    type: r["選別"] ?? "",
    enrolled: num(r["人數"]),
    limit: r["人數限制上／下限"] ?? "",
    hours: num(r["時數"]),
    term: r["期限"] ?? "",
  }));
  const paging = readPaging($);
  const result: CourseSearchResult = {
    semester: `${year}${term}`,
    page: paging.page ?? want,
    totalPages: paging.totalPages ?? (courses.length ? 1 : 0),
    totalRows: paging.totalRows ?? courses.length,
    courses,
  };
  return { result, page, base, targets };
}

export async function searchCourses(client: AisClient, q: CourseSearchQuery): Promise<CourseSearchResult> {
  return (await runSearch(client, q)).result;
}

/** 依課號（與班別）找課綱。同一課號有多個班時要指定 className，例如「3年A班」或「3A」 */
export async function syllabusByCode(
  client: AisClient,
  code: string,
  opts: { semester?: Semester; className?: string } = {}
): Promise<Record<string, string>> {
  const { result, page, base, targets } = await runSearch(client, {
    keyword: code,
    by: "code",
    exact: true,
    semester: opts.semester,
    pageSize: 50,
  });
  const norm = (s: string) => s.replace(/[年班\s]/g, "").toUpperCase();
  let index = result.courses.map((c, i) => i).filter((i) => result.courses[i].code.toUpperCase() === code.trim().toUpperCase());
  if (opts.className) index = index.filter((i) => norm(result.courses[i].class) === norm(opts.className!));
  if (!index.length) throw new AisError(`${result.semester} 找不到課號 ${code}${opts.className ? ` ${opts.className}` : ""}`, "NOT_FOUND");
  if (index.length > 1) {
    const classes = index.map((i) => `${result.courses[i].class}（${result.courses[i].teacher}）`).join("、");
    throw new AisError(`課號 ${code} 有多個班，請指定班別：${classes}`, "AMBIGUOUS");
  }
  const target = targets[index[0]];
  if (!target) throw new AisError("查詢結果沒有課綱連結", "NOT_FOUND");
  const opened = await submit(client, page, { ...base, __EVENTTARGET: target, __EVENTARGUMENT: "" });
  const pkno = /TKE2240_03\.aspx\?PKNO=(\d+)/.exec(opened.html)?.[1];
  if (!pkno) throw new AisError(`找不到 ${code} 的課綱`, "NOT_FOUND");
  return syllabus(client, pkno);
}

/** 課綱（課程內容），回傳 { 欄位中文名稱: 內容 }，例如「評量方式中文」「教學進度中文」 */
export async function syllabus(client: AisClient, pkno: string): Promise<Record<string, string>> {
  if (!/^\d+$/.test(pkno)) throw new AisError(`課綱編號應為數字：${pkno}`, "BAD_ARGUMENT");
  const res = await client.get(`${PROGRAMS.syllabus}?PKNO=${pkno}`, { referer: client.menuUrl });
  const fields = readFields(load(res.text));
  if (!Object.keys(fields).length) throw new AisError(`找不到課綱：${pkno}`, "NOT_FOUND");
  return fields;
}

// ── 成績預警 ──────────────────────────────────────────

export interface EarlyWarning {
  code: string;
  class: string;
  type: string;
  title: string;
  credits: number | null;
  /** 預警狀況；空字串表示沒有被預警 */
  warning: string;
}

/** 本學期各科的成績預警 */
export async function earlyWarnings(client: AisClient): Promise<{ semester: Semester; courses: EarlyWarning[] }> {
  const page = await openProgram(client, "Application/GRD/GRD30/GRD3060_.aspx?progcd=STU2010");
  const semester = Object.values(readFields(page.$)).find((v) => /^\d{3,4}$/.test(v)) ?? "";
  const courses = parseGrid(page.$).rows.map((r) => ({
    code: r["課號"] ?? "",
    class: r["開課班別"] ?? "",
    type: r["選別"] ?? "",
    title: r["中文課名"] ?? "",
    credits: num(r["學分"]),
    warning: r["預警狀況"] ?? "",
  }));
  return { semester, courses };
}

// ── 請假紀錄 ──────────────────────────────────────────

/** 從表格移除學號、姓名等每列都相同的個人欄位 */
function withoutIdentity(grid: Grid): Grid {
  const drop = new Set(["學號", "姓名"]);
  return {
    columns: grid.columns.filter((c) => !drop.has(c)),
    rows: grid.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k)))),
  };
}

/** 請假紀錄（假單、請假類別、起訖日、天／節數與各層審核狀態），欄位依 AIS 原始表頭 */
export async function leaves(client: AisClient): Promise<Grid> {
  const page = await openProgram(client, "Application/SEC/SEC20/SEC2050_.aspx?progcd=SEC2050");
  const result = await submit(client, page, { QUERY_BTN1: "查詢", "PC$PageSize": "200", "PC2$PageSize": "200" });
  return withoutIdentity(parseGrid(result.$));
}

// ── 獎助學金 ──────────────────────────────────────────

/** 某學年期的獎助學金申請紀錄，預設為目前學年期；欄位依 AIS 原始表頭 */
export async function scholarships(client: AisClient, semester?: Semester): Promise<{ semester: Semester; applications: Grid }> {
  const page = await openProgram(client, "Application/SGM/SGM10/SGM1080_.aspx?progcd=SGM1080");
  const { year, term } = semester
    ? splitSemester(semester)
    : { year: selected(page.$, "Q_APP_AYEAR"), term: selected(page.$, "Q_APP_SMS") };
  const result = await submit(client, page, {
    Q_APP_AYEAR: year.padStart(3, "0"),
    Q_APP_SMS: term,
    QUERY_BTN1: "查詢",
    "PC$PageSize": "200",
    "PC2$PageSize": "200",
  });
  return { semester: `${year}${term}`, applications: withoutIdentity(parseGrid(result.$)) };
}

// ── 抵免結果 ──────────────────────────────────────────

export interface CreditTransfer {
  /** 是否申請過抵免 */
  applied: boolean;
  /** AIS 的提示，例如「您尚未申請抵免作業」 */
  message?: string;
  fields: Record<string, string>;
  /** 抵免科目，欄位依 AIS 原始表頭 */
  records: Grid;
}

/** 抵免申請的審核結果（只查詢，不會按下確認） */
export async function creditTransfer(client: AisClient): Promise<CreditTransfer> {
  let page;
  try {
    page = await openProgram(client, "Application/ENR/ENR60/ENR6070_.aspx?progcd=ENR6070");
  } catch (e) {
    if (e instanceof AisError && e.code === "AIS_NOTICE" && /尚未申請/.test(e.message)) {
      return { applied: false, message: e.message.replace(/[.!]+$/, ""), fields: {}, records: { columns: [], rows: [] } };
    }
    throw e;
  }
  return { applied: true, fields: readFields(page.$), records: withoutIdentity(parseGrid(page.$)) };
}
