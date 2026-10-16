import { CookieJar } from "tough-cookie";

export const AIS_BASE = "https://ais.ntou.edu.tw/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export class AisError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "AisError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  /** application/x-www-form-urlencoded 的 body */
  form?: URLSearchParams | Record<string, string>;
  referer?: string;
  accept?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface Response {
  status: number;
  /** 跟完 redirect 之後的網址 */
  url: string;
  headers: Headers;
  body: Uint8Array;
  /** 依 charset 解碼後的文字；不是合法 UTF-8 時改用 Big5 */
  text: string;
}

export interface HttpOptions {
  /** 兩個請求之間至少間隔幾毫秒，預設 300 */
  minIntervalMs?: number;
  jar?: CookieJar;
}

function decode(body: Uint8Array, contentType: string | null): string {
  const charset = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // 不認得的 charset，往下照 UTF-8 / Big5 判斷
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("big5").decode(body);
  }
}

/**
 * 帶 cookie jar 的 HTTP client。redirect 自己跟，每一跳的 Set-Cookie 都會存進 jar
 * （fetch 自動跟 redirect 時拿不到中間的 cookie）。
 */
export class AisHttp {
  jar: CookieJar;
  private readonly minIntervalMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(opts: HttpOptions = {}) {
    this.jar = opts.jar ?? new CookieJar();
    this.minIntervalMs = opts.minIntervalMs ?? 300;
  }

  request(url: string | URL, opts: RequestOptions = {}): Promise<Response> {
    // 一次只送一個請求：AIS 的 VIEWSTATE 與 session 狀態是循序的，也避免對學校主機造成負擔
    const run = this.queue.then(() => this.send(new URL(url, AIS_BASE), opts));
    this.queue = run.catch(() => {});
    return run;
  }

  private async send(url: URL, opts: RequestOptions): Promise<Response> {
    let method = opts.method ?? (opts.form ? "POST" : "GET");
    let body: string | undefined = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
    let referer = opts.referer;
    const deadline = AbortSignal.timeout(opts.timeoutMs ?? 30_000);

    for (let hop = 0; ; hop++) {
      const wait = this.lastAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();

      const headers: Record<string, string> = {
        "User-Agent": UA,
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...opts.headers,
      };
      const cookie = await this.jar.getCookieString(url.href);
      if (cookie) headers.Cookie = cookie;
      if (referer) headers.Referer = referer;
      if (body !== undefined) {
        headers["Content-Type"] ??= "application/x-www-form-urlencoded; charset=UTF-8";
        headers.Origin ??= url.origin;
      }

      let res: globalThis.Response;
      try {
        res = await fetch(url, { method, headers, body, redirect: "manual", signal: deadline });
      } catch (e) {
        const timedOut = deadline.aborted;
        throw new AisError(
          timedOut ? `AIS 回應逾時：${url.pathname}` : `無法連線到 AIS：${(e as Error).message}`,
          timedOut ? "TIMEOUT" : "NETWORK"
        );
      }
      for (const c of res.headers.getSetCookie()) {
        await this.jar.setCookie(c, url.href, { ignoreError: true });
      }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= 5) throw new AisError("AIS redirect 次數過多", "TOO_MANY_REDIRECTS");
        await res.arrayBuffer();
        referer = url.href;
        url = new URL(location, url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        status: res.status,
        url: url.href,
        headers: res.headers,
        body: bytes,
        text: decode(bytes, res.headers.get("content-type")),
      };
    }
  }
}
