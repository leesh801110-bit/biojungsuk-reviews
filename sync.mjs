// 크몽 건수/평점 + biojungsuk 홈페이지 상품 후기를 index.html에 동기화한다.
// GitHub Actions(매시간)와 로컬 양쪽에서 동작. 사용: node sync.mjs [index.html 경로]
//
// index.html이 갖춰야 할 마커:
//   <!--BJSDATA kmong=NNN site=N score=X.Y-->      … 마지막으로 성공한 수집값
//   <!--SITE_SLOT_1--> … <!--/SITE_SLOT_1-->        … 세트당 3개 슬롯 × 2세트(총 6쌍)
// 안전 규칙: 수집 실패 시 이전 값 유지, 최종 검증 실패 시 파일을 쓰지 않는다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || join(HERE, "index.html");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const KMONG_GIG = "https://kmong.com/gig/397693";
const SITE_ROOT = "https://www.biojungsuk.co.kr";
const KMONG_CARDS = 62;          // 크몽 고정 카드 수(세트당)
const BASE_DURATION = 401;       // 62장 기준 한 바퀴 초 (속도 유지용)
const AUTO_EXCERPT_MAX = 60;     // 자동 발췌 상한(자) — 카드 높이 270px 예산 안전값
const MIN_RATING = 4;            // 이 별점 미만 후기는 카드로 싣지 않는다(건수에는 포함)
const warn = (m) => console.error((process.env.GITHUB_ACTIONS ? "::warning::" : "WARN: ") + m);

const html0 = readFileSync(FILE, "utf8");
const dataM = html0.match(/<!--BJSDATA kmong=(\d+) site=(\d+) score=([\d.]+)-->/);
if (!dataM) { console.error("BJSDATA marker missing — abort"); process.exit(1); }
let [kmong, siteCount, score] = [Number(dataM[1]), Number(dataM[2]), dataM[3]];

const overridesPath = join(HERE, "overrides.json");
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

// ── 1) 크몽 ──────────────────────────────────────────────
try {
  const body = await get(KMONG_GIG);
  const c = body.match(/"reviewCount":(\d+)/);
  const r = body.match(/([\d]+\.[\d]+),"ratingCount"/);
  if (c) kmong = Number(c[1]); else warn("kmong reviewCount not found — keeping previous");
  if (r) score = (Math.floor(Number(r[1]) * 10) / 10).toFixed(1); // 내림 표기(4.99→4.9)
} catch (e) { warn("kmong scrape failed: " + e.message + " — keeping previous"); }

// ── 2) 홈페이지 후기 ─────────────────────────────────────
function decodeRsc(html) {
  const out = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m; while ((m = re.exec(html)) !== null) { try { out.push(JSON.parse(m[1])); } catch {} }
  return out.join("\n");
}
function extractReviews(decoded) {
  const list = [];
  const re = /\{"reviewId":"(\d+)","attendSeq":\d+,"rating":(\d+(?:\.\d+)?),"content":"((?:[^"\\]|\\.)*)","writerName":"((?:[^"\\]|\\.)*)","writerProfileImageUrl":(?:"(?:[^"\\]|\\.)*"|null),"createdAt":"([^"]+)"\}/g;
  let m; while ((m = re.exec(decoded)) !== null)
    list.push({ id: m[1], rating: Number(m[2]), content: JSON.parse('"' + m[3] + '"'), writer: JSON.parse('"' + m[4] + '"'), at: m[5] });
  return list;
}
function extractTotals(decoded) {
  const t = []; const re = /"summary":\{"average":[\d.]+,"total":(\d+)\}/g;
  let m; while ((m = re.exec(decoded)) !== null) t.push(Number(m[1]));
  return t;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unent = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
function excerpt(content) {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= AUTO_EXCERPT_MAX) return clean;
  const parts = clean.split(/(?<=[.!?…~])\s+/);
  let out = "";
  for (const p of parts) { const next = out ? out + " " + p : p; if (next.length <= AUTO_EXCERPT_MAX) out = next; else break; }
  return out || clean.slice(0, AUTO_EXCERPT_MAX - 1) + "…";
}
const BOLD_RE = /(삼성바이오로직스|삼바|셀트리온|셀트|한미약품|롯데바이오로직스|롯바|녹십자|LG화학|SK바이오사이언스|알테오젠|유한양행|GSAT|최종 ?합격|서류 ?합격|1차 ?합격|2차 ?합격|합격)/g;
const bold = (s) => s.replace(BOLD_RE, "<b>$1</b>");

let reviews = null, siteTotal = null; // null = 수집 실패(이전 상태 유지)
try {
  const xml = await get(SITE_ROOT + "/sitemaps/courses.xml");
  const seqs = [...xml.matchAll(/\/classes\/(\d+)/g)].map((m) => Number(m[1]));
  if (!seqs.length) throw new Error("sitemap empty");
  reviews = []; siteTotal = 0;
  for (const seq of seqs) {
    const page = await get(`${SITE_ROOT}/classes/${seq}`);
    const name = unent(((page.match(/<title>([^<]*)<\/title>/) || [])[1] || "").split(" | ")[0].trim());
    const decoded = decodeRsc(page);
    const seen = new Set();
    for (const r of extractReviews(decoded)) if (!seen.has(r.id) && seen.add(r.id)) reviews.push({ ...r, product: name });
    const totals = extractTotals(decoded);
    siteTotal += totals.length ? Math.max(...totals) : 0;
  }
} catch (e) { warn("site scrape failed: " + e.message + " — keeping previous cards/count"); reviews = null; }

let html = html0;

// ── 3) 슬롯 채우기 ───────────────────────────────────────
if (reviews) {
  const shown = reviews.filter((r) => r.rating >= MIN_RATING).sort((a, b) => b.at.localeCompare(a.at));
  const cardHtml = (r) => {
    const o = overrides[r.id] || {};
    const text = o.text || bold(esc(excerpt(r.content)));
    const author = esc(o.author || `${r.writer} · ${r.product}`);
    return `<div class="bjs-rev__card bjs-rev__card--site"><div class="bjs-rev__cstar"><span>★★★★★</span><span class="bjs-rev__src">홈페이지 후기</span></div><p class="bjs-rev__text">${text}</p><div class="bjs-rev__author">${author}</div></div>`;
  };
  const slots = [[], [], []];
  shown.forEach((r, i) => slots[i % 3].push(cardHtml(r)));
  for (let i = 1; i <= 3; i++) {
    const re = new RegExp(`(<!--SITE_SLOT_${i}-->)[\\s\\S]*?(<!--/SITE_SLOT_${i}-->)`, "g");
    if ((html.match(re) || []).length !== 2) { console.error(`slot ${i} marker count != 2 — abort`); process.exit(1); }
    html = html.replace(re, `$1${slots[i - 1].join("\n      ")}$2`);
  }
  siteCount = siteTotal;
  // 카드 수에 비례해 속도 유지
  const dur = Math.round((BASE_DURATION * (KMONG_CARDS + shown.length)) / KMONG_CARDS);
  html = html.replace(/bjs-rev-scroll \d+s/g, `bjs-rev-scroll ${dur}s`);
}

// ── 4) 배지·점수·데이터 마커 ─────────────────────────────
html = html.replace(/(bjs-rev__badge">크몽·홈페이지 후기 )\d+(건)/, `$1${kmong + siteCount}$2`);
html = html.replace(/(bjs-rev__score">)[\d.]+/, `$1${score}`);
html = html.replace(/<!--BJSDATA kmong=\d+ site=\d+ score=[\d.]+-->/, `<!--BJSDATA kmong=${kmong} site=${siteCount} score=${score}-->`);

// ── 5) 검증 후 기록 ──────────────────────────────────────
const siteCards = (html.match(/bjs-rev__card--site/g) || []).length - 1; // -1 = CSS 셀렉터
const totalCards = (html.match(/<div class="bjs-rev__card[" ]/g) || []).length;
const countPat = (html.match(/후기 \d+건/g) || []).length;
const checks = [
  [siteCards % 2 === 0 && siteCards >= 0, `site cards odd: ${siteCards}`],
  [totalCards === KMONG_CARDS * 2 + siteCards, `total cards ${totalCards} != ${KMONG_CARDS * 2 + siteCards}`],
  [countPat === 1, `'후기 N건' pattern x${countPat}`],
  [/bjs-rev__score">[\d.]+/.test(html), "score span missing"],
  [html.length > 20000 && html.length < 150000, `size ${html.length}`],
];
for (const [ok, msg] of checks) if (!ok) { console.error("VALIDATION FAIL: " + msg + " — not writing"); process.exit(1); }

if (html === html0) { console.log("no change"); process.exit(0); }
writeFileSync(FILE, html, "utf8");
console.log(`updated: kmong=${kmong} site=${siteCount} score=${score} siteCards=${siteCards / 2}/set`);
