import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

// ddddocr 的 common_old 模型（https://github.com/sml2h3/ddddocr，MIT）
const MODEL_PATH = fileURLToPath(new URL("../models/common_old.onnx", import.meta.url));
const CHARSET_PATH = fileURLToPath(new URL("../models/common_old_charset.json", import.meta.url));
const HEIGHT = 64;

let loading: Promise<{ session: ort.InferenceSession; charset: string[] }> | undefined;

function load() {
  loading ??= (async () => {
    const [session, charset] = await Promise.all([
      // 模型宣告的輸出 shape 跟實際不同，onnxruntime 每次都會警告，關掉 warning
      ort.InferenceSession.create(MODEL_PATH, { logSeverityLevel: 3 }),
      readFile(CHARSET_PATH, "utf8").then((s) => JSON.parse(s) as string[]),
    ]);
    return { session, charset };
  })().catch((e) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

export interface OcrOptions {
  /** 透明背景先鋪成白色，預設 true */
  flattenWhite?: boolean;
}

/** 辨識驗證碼圖片，回傳模型輸出的原始文字 */
export async function recognize(image: Uint8Array, opts: OcrOptions = {}): Promise<string> {
  const { session, charset } = await load();
  let img = sharp(image);
  if (opts.flattenWhite ?? true) img = img.flatten({ background: "#ffffff" });
  const meta = await sharp(image).metadata();
  const width = Math.max(1, Math.floor((meta.width ?? HEIGHT) * (HEIGHT / (meta.height ?? HEIGHT))));
  const { data } = await img
    .resize(width, HEIGHT, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const input = new Float32Array(width * HEIGHT);
  for (let i = 0; i < input.length; i++) input[i] = data[i] / 255;
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 1, HEIGHT, width]) };
  const out = (await session.run(feeds))[session.outputNames[0]];

  // CTC greedy decode：每步取最大值，略過重複與 blank（index 0）
  const logits = out.data as Float32Array;
  const [steps, , classes] = out.dims as number[];
  let text = "";
  let last = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    for (let c = 1; c < classes; c++) {
      if (logits[t * classes + c] > logits[t * classes + best]) best = c;
    }
    if (best !== last && best !== 0) text += charset[best];
    last = best;
  }
  return text;
}
