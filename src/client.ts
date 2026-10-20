import { AIS_BASE, AisError, AisHttp, type HttpOptions, type RequestOptions, type Response } from "./http.js";
import { alertMessage, clean, clientRedirect, load, serializeForm } from "./form.js";
import { recognize } from "./ocr.js";
import * as features from "./features.js";
import { CookieJar } from "tough-cookie";

const LOGIN_URL = new URL("Default.aspx", AIS_BASE).href;
const MAINFRAME_URL = new URL("MainFrame.aspx", AIS_BASE).href;
const MENU_URL = new URL("MenuTree.aspx", AIS_BASE).href;

export interface AisClientOptions extends HttpOptions {
  username: string;
  password: string;
  /** 驗證碼辨識，預設用內建的 OCR 模型 */
  solveCaptcha?: (image: Uint8Array) => Promise<string>;
  /** 驗證碼最多嘗試幾次，預設 5 */
  maxCaptchaAttempts?: number;
  log?: (message: string) => void;
}

/** 頁面是否表示 session 已失效（被導回登入頁或逾時） */
export const isSessionExpired = (html: string) =>
  /(?:id|name)=["']M_PORTAL_LOGIN_ACNT["']/.test(html) || /使用時間逾時|使用時間頁面已逾時/.test(html);

export class AisClient {
  readonly http: AisHttp;
  private readonly opts: AisClientOptions;
  private loggedIn = false;
  private loginTask?: Promise<void>;
  private lastFailure?: AisError;

  constructor(opts: AisClientOptions) {
    this.opts = opts;
    this.http = new AisHttp(opts);
  }

  private log(message: string) {
    this.opts.log?.(message);
  }

  get isLoggedIn() {
    return this.loggedIn;
  }

  /** 登入；同時有多個呼叫時只會登入一次 */
  login(): Promise<void> {
    this.loginTask ??= this.doLogin().finally(() => (this.loginTask = undefined));
    return this.loginTask;
  }

  private async doLogin() {
    // 帳密錯誤後不自動重試，以免帳號被鎖
    if (this.lastFailure?.code === "BAD_CREDENTIALS") throw this.lastFailure;
    const maxAttempts = this.opts.maxCaptchaAttempts ?? 5;
    const solve = this.opts.solveCaptcha ?? ((img) => recognize(img));
    let kickedOther = false;
    // 舊 session 的 cookie 還在時，登入頁不會給驗證碼
    this.loggedIn = false;
    await this.http.jar.removeAllCookies();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const page = await this.openLoginPage();
      const $ = load(page.text);
      const src = $("#importantImg").attr("src");
      if (!src) throw new AisError("AIS 登入頁沒有驗證碼圖片，頁面格式可能已變更", "LOGIN_PAGE_CHANGED");
      const captcha = await this.http.request(new URL(src, page.url), {
        referer: page.url,
        accept: "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
      });
      const code = (await solve(captcha.body)).trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) {
        this.log(`驗證碼辨識結果「${code}」不是 4 碼，換一張（${attempt}/${maxAttempts}）`);
        continue;
      }

      const form = serializeForm($, "#form1");
      const account = $("#M_PORTAL_LOGIN_ACNT").attr("name") ?? "M_PORTAL_LOGIN_ACNT";
      const password = $("input[type=password][name]").first().attr("name") ?? "LoginPWD";
      const captchaField = $("#M_PW2").attr("name") ?? "M_PW2";
      const submit = $("#form1 input[type=submit][name]").first();
      form.set(account, this.opts.username.trim().toUpperCase());
      form.set(password, this.opts.password);
      form.set(captchaField, code);
      form.set(submit.attr("name") ?? "LGOIN_BTN", submit.attr("value") ?? "登入/Login");

      const action = new URL($("#form1").attr("action") ?? LOGIN_URL, page.url).href;
      const res = await this.http.request(action, { form, referer: page.url });

      if (/ConfirmInOrOut/i.test(res.url) || res.text.includes("ConfirmInOrOut.aspx")) {
        // 帳號在別處已登入：AIS 要求先登出另一個 session
        if (kickedOther) throw new AisError("AIS 回報重複登入，登出後仍無法登入", "SESSION_CONFLICT");
        this.log("AIS 回報重複登入，登出舊的 session 後重新登入");
        await this.http.request("LogOut.aspx", { referer: res.url });
        kickedOther = true;
        attempt--;
        continue;
      }

      // 成功時 AIS 仍回傳登入頁（再用 JS 開 MainFrame），只能從 .ASPXAUTH cookie 判斷
      const cookies = await this.http.jar.getCookies(AIS_BASE);
      if (cookies.some((c) => c.key === ".ASPXAUTH")) {
        await this.verifySession();
        this.loggedIn = true;
        this.lastFailure = undefined;
        this.log(`已登入 AIS：${this.opts.username.toUpperCase()}`);
        return;
      }

      // 失敗原因用 alert 顯示，例如「驗證碼錯誤，請再重新輸入!!」「帳號或密碼錯誤，請查明後再登入…」
      const message =
        alertMessage(res.text) ||
        clean(load(res.text)("#det_position, #det_position1, .det_position").first().text()) ||
        "登入失敗（AIS 沒有說明原因）";
      // 只認明確的驗證碼錯誤；其他錯誤（例如「請檢查密碼」）重試會增加帳號被鎖的風險
      if (/驗證碼|captcha/i.test(message)) {
        this.log(`驗證碼錯誤，換一張（${attempt}/${maxAttempts}）`);
        continue;
      }
      this.lastFailure = new AisError(`AIS 登入失敗：${message}`, "BAD_CREDENTIALS");
      throw this.lastFailure;
    }
    throw new AisError(`驗證碼連續 ${maxAttempts} 次辨識失敗`, "CAPTCHA_FAILED");
  }

  /** 匯出目前的登入狀態（cookie），內容等同登入憑證 */
  async exportSession(): Promise<string> {
    return JSON.stringify(await this.http.jar.serialize());
  }

  /**
   * 匯入 exportSession() 的內容，沿用之前的登入。
   * 不會先驗證是否過期；之後的請求發現過期時會自動重新登入。
   */
  async importSession(data: string) {
    this.http.jar = await CookieJar.deserialize(JSON.parse(data));
    const cookies = await this.http.jar.getCookies(AIS_BASE);
    this.loggedIn = cookies.some((c) => c.key === ".ASPXAUTH");
  }

  /** 帳密改了之後呼叫，允許再次自動登入 */
  resetFailures() {
    this.lastFailure = undefined;
  }

  private async openLoginPage(): Promise<Response> {
    let page = await this.http.request(LOGIN_URL);
    // 沒有 session 時 Default.aspx 的驗證碼沒有 src，會先用 JS 導到排隊頁 DefaultQ.aspx 再導回來
    for (let i = 0; i < 4 && !/<img[^>]*\bsrc=[^>]*importantImg|importantImg[^>]*\bsrc=/.test(page.text); i++) {
      const next = clientRedirect(page.text, page.url);
      if (!next) break;
      page = await this.http.request(next, { referer: page.url });
    }
    if (page.status >= 400) throw new AisError(`無法開啟 AIS 登入頁（HTTP ${page.status}）`, "HTTP", page.status);
    return page;
  }

  private async verifySession() {
    const main = await this.http.request(MAINFRAME_URL, { referer: AIS_BASE });
    // 功能頁要先載入過選單才開得了，沒載入時會被導回登入頁
    const menu = await this.http.request(MENU_URL, { referer: MAINFRAME_URL });
    if ([main, menu].some((r) => r.status >= 400 || isSessionExpired(r.text))) {
      throw new AisError("AIS 已接受帳密，但登入的 session 沒有建立", "SESSION_NOT_ESTABLISHED");
    }
  }

  /**
   * 送出需要登入的請求。session 失效時會自動登入一次再重送。
   * 寫入類請求請設 retry: false，避免重複送出。
   */
  async get(url: string | URL, opts: RequestOptions & { retry?: boolean } = {}): Promise<Response> {
    if (!this.loggedIn) await this.login();
    const res = await this.http.request(url, opts);
    if (!isSessionExpired(res.text) && res.status !== 401) return res;
    this.loggedIn = false;
    if (opts.retry === false) throw new AisError("AIS session 已失效", "SESSION_EXPIRED");
    this.log("AIS session 已失效，重新登入");
    await this.login();
    const again = await this.http.request(url, opts);
    if (isSessionExpired(again.text)) throw new AisError("重新登入後 AIS session 仍然無效", "SESSION_EXPIRED");
    return again;
  }

  /** 個人課表與選課清單，預設為目前學年期 */
  timetable(semester?: features.Semester) {
    return features.timetable(this, semester);
  }

  /** 歷年成績 */
  grades() {
    return features.grades(this);
  }

  /** 本學期缺曠紀錄 */
  absences() {
    return features.absences(this);
  }

  /** 操行成績與獎懲紀錄 */
  conduct() {
    return features.conduct(this);
  }

  /** 畢業資格：應修學分、必修科目對照、學分統計與審查結果 */
  graduation() {
    return features.graduation(this);
  }

  /** 依課名、課號或教師查詢開課資料 */
  searchCourses(query: features.CourseSearchQuery) {
    return features.searchCourses(this, query);
  }

  /** 本學期成績預警 */
  earlyWarnings() {
    return features.earlyWarnings(this);
  }

  /** 請假紀錄 */
  leaves() {
    return features.leaves(this);
  }

  /** 獎助學金申請紀錄，預設為目前學年期 */
  scholarships(semester?: features.Semester) {
    return features.scholarships(this, semester);
  }

  /** 抵免申請的審核結果 */
  creditTransfer() {
    return features.creditTransfer(this);
  }

  /** 本期的課程問卷與是否已填 */
  courseSurveys() {
    return features.courseSurveys(this);
  }

  /** 某門課問卷的題目（只讀取） */
  getSurvey(code: string, teacher?: string) {
    return features.getSurvey(this, code, teacher);
  }

  /** 送出課程問卷；每份只能填一次，送出後無法修改 */
  submitSurvey(code: string, answers: features.SurveyAnswer[], opts?: { teacher?: string }) {
    return features.submitSurvey(this, code, answers, opts);
  }

  /** 課綱，pkno 來自 timetable() 的 slots */
  syllabus(pkno: string) {
    return features.syllabus(this, pkno);
  }

  /** 依開課系所（與年級、班別）列出某學年期的所有課 */
  departmentCourses(query: features.DepartmentCoursesQuery) {
    return features.departmentCourses(this, query);
  }

  /** 依課號（與班別）找課綱 */
  syllabusByCode(code: string, opts?: { semester?: features.Semester; className?: string }) {
    return features.syllabusByCode(this, code, opts);
  }

  get menuUrl() {
    return MENU_URL;
  }

  get mainFrameUrl() {
    return MAINFRAME_URL;
  }
}
