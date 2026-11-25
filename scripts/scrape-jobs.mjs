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

// Teletalk Alljobs: org-list API → প্রতিষ্ঠান প্রতি একটি আইটেম (ওই প্রতিষ্ঠানের সব পদ একসাথে)।
// ⚠ এই API-তে ডেডলাইন নেই, তাই আইটেমগুলো আপাতত pending.json এ যাবে (detail API পেলে ডেডলাইন বসানো যাবে)।
async function collectTeletalkApi(src) {
  const items = [];
  let total = Infinity;
  for (let page = 1; items.length < total; page++) { // কোনো page limit নেই — API-র count শেষ না হওয়া পর্যন্ত
    const r = JSON.parse(await get(`${src.api}?page=${page}&limit=${src.limit || 20}`));
    total = r.count ?? total;
    const orgs = r.govtOrgJobs || [];
    if (!orgs.length) break;
    for (const o of orgs) {
      const titles = (o.govt_jobs || []).map((j) => clean(j.job_title_bn || j.job_title)).filter(Boolean);
      const orgName = clean(o.name_bn || o.name);
      items.push({
        id: idOf(`teletalk-org-${o.id}-${o.job_created_at}`),
        org: orgName,
        title: `${orgName} — ${titles.length}টি পদে নিয়োগ`,
        positions: String(titles.length),
        posted: (o.job_created_at || "").slice(0, 10) || today,
        startDate: (o.job_created_at || "").slice(0, 10) || today,
        deadline: null,
        eligibility: null, applyMode: "অনলাইন (Teletalk Alljobs)",
        applyUrl: src.url, pdfUrl: null, sourceUrl: src.url,
        orgWebsite: o.website || null,
        source: "teletalk", priority: 1,
        summary: `পদসমূহ: ${titles.join(", ")}`,
      });
    }
    if (orgs.length < (src.limit || 20)) break;
  }
  return items;
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
        // ডেডলাইন API-তে নেই, তাই এগুলো সরাসরি jobs.json এ যায় (অ্যাপে "শেষ তারিখ দেখুন" দেখাবে)
        const have = new Set(jobs.map((j) => j.id));
        const fresh = all.filter((j) => !have.has(j.id));
        console.log(`  ${all.length} প্রতিষ্ঠান, ${fresh.length} নতুন`);
        for (const job of fresh) { jobs.push(job); added++; }
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

  fs.writeFileSync(OUT, JSON.stringify(final, null, 2));
  fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2));
  console.log(`✔ jobs=${final.length} (+${added}), pending=${pending.length} (+${queued})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
