// 送出一份課程問卷。每份問卷只能填一次，送出後無法修改。
// node --env-file=.env example/submit-survey.js <課號> <各選擇題的選項序號，逗號分隔> [文字題內容] [教師]
// 例：node --env-file=.env example/submit-survey.js B570332J 1,1,1,1,1,1
import { AisClient } from "../dist/index.js";

const [code, choices, text, teacher] = process.argv.slice(2);
if (!code || !choices) {
  console.error("用法：submit-survey.js <課號> <選項序號,...> [文字題內容] [教師]");
  process.exit(1);
}

const client = new AisClient({
  username: process.env.AIS_USER,
  password: process.env.AIS_PASS,
  log: (m) => console.error(m),
});

const survey = await client.getSurvey(code, teacher);
const picks = choices.split(",").map(Number);
const answers = [];
for (const q of survey.questions) {
  if (q.kind === "choice") {
    const choice = picks.shift();
    if (choice) answers.push({ question: q.number, choice });
    console.log(`${q.number}. ${q.text.slice(0, 30)}… → ${choice ? q.options[choice - 1] : "（不作答）"}`);
  } else {
    if (text) answers.push({ question: q.number, text });
    console.log(`${q.number}. ${q.text.slice(0, 30)}… → ${text || "（留白）"}`);
  }
}

try {
  const result = await client.submitSurvey(code, answers, { teacher });
  console.log(`\n已送出 ${code} ${survey.title}${result.message ? `（AIS：${result.message}）` : ""}`);
} catch (e) {
  console.log(`\n沒有完成：${e.code} ${e.message}`);
}
const { surveys } = await client.courseSurveys();
const todo = surveys.filter((s) => !s.filled);
console.log(`已填 ${surveys.length - todo.length} 份，待填 ${todo.length} 份：${todo.map((s) => s.title).join("、")}`);
