// চালান: node scripts/scrape-jobs.mjs
// ফল: public/jobs.json (ডেডলাইনসহ, অ্যাপে দেখাবে) + public/pending.json (ডেডলাইন পাওয়া যায়নি — হাতে দেখে data/manual.json এ দিন)
import fs from "node:fs";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { SOURCES } from "./sources.mjs";
import { findDeadline, findStart, findPositions, todayDhaka, addDays, diffDays } from "./lib.mjs";

const OUT = "public/jobs.json", PENDING = "public/pending.json", MANUAL = "data/manual.json";
const KEEP_AFTER_DEADLINE = 14;       // মেয়াদ শেষের পর কত দিন লিস্টে রাখবে
const UA = "Mozilla/5.0 (compatible; FocusGoJobsBot/1.0)";
const today = todayDhaka();

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; } };
const idOf = (url) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function get(url, asBuffer = false) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return asBuffer ? Buffer.from(await r.arrayBuffer()) : r.text();
}

// ঐচ্ছিক: ANTHROPIC_API_KEY থাকলে Claude দিয়ে PDF/পেজ থেকে ফিল্ড বের করে
async function extractWithAI({ title, text, pdfBuf }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const content = [];
  if (pdfBuf) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBuf.toString("base64") } });
  content.push({ type: "text", text:
    `এটি একটি সরকারি চাকরির নিয়োগ বিজ্ঞপ্তি। শিরোনাম: ${title}\n${text ? "পেজের লেখা:\n" + text.slice(0, 6000) : ""}\n` +
    `শুধু JSON দিন (অন্য কিছু নয়): {"positions": string|null, "startDate": "YYYY-MM-DD"|null, "deadline": "YYYY-MM-DD"|null, ` +
    `"eligibility": string|null, "applyMode": string|null, "applyUrl": string|null, "summary": "বাংলায় ২ বাক্য"|null}. ` +
    `তথ্য না থাকলে null দিন, অনুমান করবেন না।` });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 600, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) { console.warn("AI error", r.status); return null; }
  const j = await r.json();
  const raw = j.content?.map((c) => c.text || "").join("") || "";
  try { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { return null; }
}

async function collectLinks(src) {
  // কোনো limit নেই: category-র /page/2/, /page/3/ ... ধরে শেষ page পর্যন্ত যায়।
  // যে page-এ আর কোনো মিল পাওয়া যায় না, সেখানেই থামে।
  const seen = new Set(), out = [];
  for (let page = 1; ; page++) {
    const url = page === 1 ? src.url : src.url.replace(/\/?$/, "/") + `page/${page}/`;
    let html; try { html = await get(url); } catch { break; }
    const $ = cheerio.load(html);
    const scope = src.selector ? $(src.selector) : $.root();
    let found = 0;
    scope.find("a[href]").each((_, a) => {
      const title = clean($(a).text());
      if (title.length < 12 || !src.include.test(title)) return;
      let href; try { href = new URL($(a).attr("href"), src.url).href; } catch { return; }
      if (seen.has(href)) return; seen.add(href); found++;
      out.push({ title, href });
    });
    if (!found) break;
  }
  return out;
}

async function buildJob(src, { title, href }) {
  const isPdf = /\.pdf($|\?)/i.test(href);
  let text = "", pdfBuf = null;
  try {
    if (isPdf) pdfBuf = await get(href, true);
    else text = clean(cheerio.load(await get(href)).root().text());
  } catch (e) { console.warn("  detail fail:", e.message); }

  const job = {
    id: idOf(href), org: src.org, title, positions: findPositions(text), posted: today,
    startDate: findStart(text) || today, deadline: findDeadline(text),
    eligibility: null, applyMode: null, applyUrl: src.applyUrl || href, pdfUrl: isPdf ? href : null,
    sourceUrl: href, summary: null, source: "collection", priority: 2,
  };
  const ai = await extractWithAI({ title, text, pdfBuf });
  if (ai) for (const k of ["positions", "startDate", "deadline", "eligibility", "applyMode", "applyUrl", "summary"]) {
    if (ai[k]) job[k] = ai[k];            // AI-র তথ্য থাকলে সেটাই (regex-কে ওভাররাইড)
  }
  return job;
}

// Teletalk Alljobs: org-list API -> প্রতিষ্ঠান, তারপর প্রতিষ্ঠানপ্রতি list API -> প্রতিটি পদের
// সরাসরি link + আবেদন শুরুর তারিখ (published_date) + শেষ তারিখ (deadline_date) + শূন্যপদ (vacancy)।
// Direct link-এর format (সাইটে click করে যাচাই করা): /jobs/government/<orgId>?jobId=<jobId>
// তারিখগুলো API-তে UTC-তে থাকে; ঢাকার তারিখে রূপান্তর করা হয় (UTC+6)।
const dhakaDate = (isoStr) => {
  if (!isoStr) return null;
  const t = new Date(isoStr).getTime();
  return Number.isNaN(t) ? null : new Date(t + 6 * 3600 * 1000).toISOString().slice(0, 10);
};

async function collectTeletalkApi(src) {
  const apiBase = src.api.replace(/\/org-list$/, "");
  const orgs = [];
  let total = Infinity;
  for (let page = 1; orgs.length < total; page++) { // কোনো page limit নেই
    const r = JSON.parse(await get(`${src.api}?page=${page}&limit=${src.limit || 20}`));
    total = r.count ?? total;
    const batch = r.govtOrgJobs || [];
    if (!batch.length) break;
    orgs.push(...batch);
    if (batch.length < (src.limit || 20)) break;
  }
  const items = [];
  for (const o of orgs) {
    let jobs = [];
    try {
      const r = JSON.parse(await get(`${apiBase}/list?orgId=${o.id}&skipLimit=YES`));
      jobs = r.govtJobs || [];
    } catch (e) { console.warn("  org list fail:", o.id, e.message); continue; }
    for (const j of jobs) {
      const title = clean(j.job_title_bn || j.job_title);
      if (!title || !j.id) continue;
      const orgName = clean((j.job_utilities_govtorganization || {}).name_bn || (j.job_utilities_govtorganization || {}).name || o.name_bn || o.name);
      const link = `${src.url}/${o.id}?jobId=${j.id}`;
      const vac = j.vacancy_not_specific ? null : (j.vacancy != null && /^\d+$/.test(String(j.vacancy).trim()) ? String(parseInt(j.vacancy, 10)) : (j.vacancy || null));
      items.push({
        id: `tg-${j.id}`,
        org: orgName,
        title,
        positions: vac,
        posted: dhakaDate(j.created_at) || today,
        startDate: dhakaDate(j.published_date) || dhakaDate(j.created_at) || today,
        deadline: dhakaDate(j.deadline_date),
        eligibility: null, applyMode: "অনলাইন (Teletalk Alljobs)",
        applyUrl: link, pdfUrl: null, sourceUrl: link,
        applySite: j.application_site || null,
        orgWebsite: o.website || null,
        source: "teletalk", priority: 1,
        summary: null,
      });
    }
  }
  return items;
}


// ================= Duplicate বাদ: BD Govt Job-এর যেসব সার্কুলার Teletalk-এও আছে =================
// Teletalk মূল সোর্স (direct link + deadline থাকে), তাই একই প্রতিষ্ঠানের সংকলন কপি বাদ যাবে।
const BN_D = {"০":"0","১":"1","২":"2","৩":"3","৪":"4","৫":"5","৬":"6","৭":"7","৮":"8","৯":"9"};
const normT = (x) => (x || "").normalize("NFC")
  .replace(/\u09AF\u09BC/g, "\u09DF").replace(/[০-৯]/g, (c) => BN_D[c])
  .replace(/\u09C0/g, "\u09BF").replace(/র্প/g, "রপ").replace(/লিঃ|লিমিটেড/g, " ")
  .toLowerCase().replace(/[()\-\–,./:;।'"’‘]/g, " ").replace(/\s+/g, " ").trim();
const PLACES = { "বগুড়া":"bogra", "ঢাকা":"dhaka", "দিনাজপুর":"dinajpur", "চট্টগ্রাম":"chattogram", "রাজশাহী":"rajshahi", "খুলনা":"khulna", "বরিশাল":"barishal", "সিলেট":"sylhet", "রংপুর":"rangpur", "ময়মনসিংহ":"mymensingh", "কুমিল্লা":"cumilla", "গাজীপুর":"gazipur", "নারায়ণগঞ্জ":"narayanganj", "যশোর":"jashore", "নোয়াখালী":"noakhali", "শেরপুর":"sherpur", "লালমনিরহাট":"lalmonirhat", "নেত্রকোনা":"netrokona", "চাঁদপুর":"chandpur", "সিরাজগঞ্জ":"sirajganj", "রাঙামাটি":"rangamati", "খাগড়াছড়ি":"khagrachhari", "বাগেরহাট":"bagerhat", "মাগুরা":"magura", "রাজবাড়ী":"rajbari" };
function tgKeysOf(org) {
  const codeM = org.match(/\(([^)]+)\)/);
  const keys = { code: codeM ? codeM[1].replace(/\s/g, "").toLowerCase() : null,
    name: normT(org.replace(/\([^)]+\)/g, "")), alt: normT((org.match(/\(([^)]+)\)/) || [])[1] || ""), places: new Set() };
  for (const [bn, en] of Object.entries(PLACES)) if (keys.name.includes(bn) || keys.name.includes(en)) keys.places.add(en);
  return keys;
}
function isDupOfTeletalk(title, tgKeysList) {
  let bn = (title || "").replace(/^\s*[০-৯0-9]+\s*পদে\s*/, "");
  if (/^\s*সকল\s/.test(bn)) return false; // "সকল ..." roundup পোস্ট রাখা হবে
  bn = normT(bn.split(/নিয়োগ|নিয়োগ|Job Circular|job circular/)[0]);
  const latin = normT(((title || "").match(/[A-Za-z][A-Za-z0-9 .,&-]*$/g) || [""])[0] || "");
  const codes = new Set(((title || "").match(/[A-Z]{2,}[0-9]*/g) || []).map((c) => c.toLowerCase()));
  const hay = bn + " " + latin;
  const places = new Set();
  for (const [b, en] of Object.entries(PLACES)) if (hay.includes(b) || hay.includes(en)) places.add(en);
  for (const k of tgKeysList) {
    if (k.code && codes.has(k.code)) return true;
    if (bn.length >= 5 && (k.name.includes(bn) || bn.includes(k.name))) return true;
    if (latin.length >= 8 && (k.name.includes(latin) || latin.includes(k.name))) return true;
    if (k.alt && k.alt.length >= 4 && (latin.includes(k.alt) || bn.includes(k.alt))) return true;
    const cats = [["বিভাগীয় কমিশনার", "divisional commissioner"], ["পুলিশ সুপার", "police"], ["জেলা প্রশাসক", "dc office"], ["সিভিল সার্জন", "civil surgeon"]];
    for (const [bnC, enC] of cats) if (bn.includes(bnC) && (k.name.includes(bnC) || k.name.includes(enC)) && [...places].some((pl) => k.places.has(pl))) return true;
    const cTax = bn.includes("কর অঞ্চল") || /\btax/.test(latin);
    const kTax = k.name.includes("কর অঞ্চল") || /\btax/.test(k.name);
    if (cTax && kTax) {
      const cNums = new Set(hay.match(/\d+/g) || []), kNums = new Set(k.name.match(/\d+/g) || []);
      const numShare = [...cNums].some((n) => kNums.has(n));
      const placeShare = [...places].some((pl) => k.places.has(pl));
      if ((cNums.size && numShare) || (placeShare && (cNums.size === 0 || kNums.size === 0 || numShare))) return true;
    }
  }
  return false;
}


// ============ শিক্ষাপ্রতিষ্ঠান বাদ: বিশ্ববিদ্যালয় / স্কুল / কলেজের circular আসবে না ============
// অধিদপ্তর/মন্ত্রণালয়ের circular (যেমন প্রাথমিক শিক্ষক নিয়োগ) থাকবে — ওগুলো প্রতিষ্ঠান না, নিয়োগকারী কর্তৃপক্ষ।
// BCPS (বাংলাদেশ কলেজ অব ফিজিশিয়ানস্) ব্যতিক্রম — নামে কলেজ হলেও ওটা চিকিৎসকদের প্রতিষ্ঠান, পড়ার কলেজ না।
const EDU_WORDS = ["বিশ্ববিদ্যালয়", "বিশ্ববিদ্যালয়", "বিদ্যালয়", "বিদ্যালয়", "স্কুল", "কলেজ", "university", "school", "college"];
const EDU_KEEP = ["অধিদপ্তর", "মন্ত্রণালয়", "মন্ত্রণালয়", "শিক্ষা বোর্ড", "ফিজিশিয়ানস", "bcps"];
function isEduInstitution(j) {
  const t = (String(j.title || "") + " " + String(j.org || "")).toLowerCase();
  if (EDU_KEEP.some((w) => t.includes(w.toLowerCase()))) return false;
  return EDU_WORDS.some((w) => t.includes(w.toLowerCase()));
}

async function main() {
  const jobs = read(OUT), pending = read(PENDING);
  const known = new Set([...jobs, ...pending].map((j) => j.id));
  let added = 0, queued = 0;

  for (const src of SOURCES) {
    console.log(`▶ ${src.org} — ${src.url}`);
    if (src.type === "teletalk-api") {
      try {
        const all = await collectTeletalkApi(src);
        // পুরনো org-ভিত্তিক Teletalk আইটেম (default linkওয়ালা) ফেলে দিয়ে পদ-ভিত্তিক নতুনগুলো বসে
        for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].source === "teletalk") jobs.splice(i, 1);
        for (const job of all) { jobs.push(job); added++; }
        console.log(`  ${all.length}টি পদ (সরাসরি link সহ)`);
      } catch (e) { console.warn("  api fail:", e.message); }
      continue;
    }
    let links = [];
    try { links = await collectLinks(src); } catch (e) { console.warn("  list fail:", e.message); continue; }
    const fresh = links.filter((l) => !known.has(idOf(l.href))); // কোনো limit নেই — সব নতুন লিংকই নেওয়া হবে
    console.log(`  ${links.length} লিংক, ${fresh.length} নতুন`);
    for (const l of fresh) {
      const job = await buildJob(src, l);
      known.add(job.id);
      if (job.deadline && diffDays(job.deadline, today) >= 0) { jobs.push(job); added++; }
      else if (!job.deadline) { pending.push(job); queued++; }   // ডেডলাইন অজানা → হাতে দেখুন
      // ডেডলাইন পেরিয়ে গেলে বাদ
    }
  }

  // হাতে-দেওয়া সার্কুলার (data/manual.json) মার্জ — একই id হলে manual জেতে
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const m of read(MANUAL)) byId.set(m.id || idOf(m.applyUrl || m.title), { id: idOf(m.applyUrl || m.title), posted: today, ...m });

  const final = [...byId.values()]
    .filter((j) => (j.deadline ? diffDays(today, j.deadline) <= KEEP_AFTER_DEADLINE : diffDays(today, j.posted) <= 30))  // ডেডলাইন নেই → প্রকাশের ৩০ দিন পর্যন্ত রাখে
    .sort((a, b) => ((a.priority ?? 2) - (b.priority ?? 2)) || (b.posted > a.posted ? 1 : -1)); // মূল সোর্স Teletalk সবার আগে

  // Teletalk-এ থাকা প্রতিষ্ঠানের সংকলন duplicate বাদ (পুরনো জমে থাকা কপিও পরিষ্কার হবে)
  const tgKeysList = [...new Set(final.filter((j) => j.source === "teletalk").map((j) => j.org))].map(tgKeysOf);
  const deduped = final.filter((j) => j.source === "teletalk" || !isDupOfTeletalk(j.title, tgKeysList));
  if (deduped.length < final.length) console.log(`Duplicates removed (also on Teletalk): ${final.length - deduped.length}`);
  const noEdu = deduped.filter((j) => !isEduInstitution(j));
  if (noEdu.length < deduped.length) console.log(`Education institutions removed (university/school/college): ${deduped.length - noEdu.length}`);

  fs.writeFileSync(OUT, JSON.stringify(noEdu, null, 2));
  fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2));
  console.log(`✔ jobs=${noEdu.length} (+${added}), pending=${pending.length} (+${queued})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
