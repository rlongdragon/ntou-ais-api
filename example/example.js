// node --env-file=.env example/example.js [timetable|grades|absences|conduct|graduation|search|syllabus]...
import { AisClient } from "../dist/index.js";

const client = new AisClient({
  username: process.env.AIS_USER,
  password: process.env.AIS_PASS,
  log: (m) => console.error(m),
});

const runs = {
  timetable: () => client.timetable(),
  grades: () => client.grades(),
  absences: () => client.absences(),
  conduct: () => client.conduct(),
  graduation: () => client.graduation(),
  search: () => client.searchCourses({ keyword: "作業系統" }),
  syllabus: () => client.syllabus("136785734"),
  earlyWarnings: () => client.earlyWarnings(),
  leaves: () => client.leaves(),
  scholarships: () => client.scholarships(),
  scholarships1142: () => client.scholarships("1142"),
  creditTransfer: () => client.creditTransfer(),
  syllabusByCode: () => client.syllabusByCode("B5703660", { className: "3B" }),
  ambiguous: () => client.syllabusByCode("B5703660").catch((e) => `${e.code}: ${e.message}`),
};

const which = process.argv.slice(2);
for (const name of which.length ? which : Object.keys(runs)) {
  const started = Date.now();
  const result = await runs[name]();
  console.log(`\n=== ${name} (${Date.now() - started} ms)`);
  console.log(JSON.stringify(result, null, 1).slice(0, 2500));
}
