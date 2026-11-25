// চালান: node scripts/scrape-jobs.mjs
// ফল: public/jobs.json (ডেডলাইনসহ, অ্যাপে দেখাবে) + public/pending.json (ডেডলাইন পাওয়া যায়নি — হাতে দেখে data/manual.json এ দিন)
import fs from "node:fs";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { SOURCES } from "./sources.mjs";
import { findDeadline, findStart, findPositions, todayDhaka, addDays, diffDays } from "./lib.mjs";

const OUT = "public/jobs.json", PENDING = "public/pending.json", MANUAL = "data/manual.json";
const KEEP_AFTER_DEADLINE = 14;       // মেয়াদ শেষের পর কত দিন লিস্টে রাখবে
const MAX_NEW_PER_SOURCE = 15;        // এক রানে প্রতি সোর্স থেকে সর্বোচ্চ নতুন আইটেম
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
  const html = await get(src.url);
  const $ = cheerio.load(html);
  const scope = src.selector ? $(src.selector) : $.root();
  const seen = new Set(), out = [];
  scope.find("a[href]").each((_, a) => {
    const title = clean($(a).text());
    if (title.length < 12 || !src.include.test(title)) return;
    let href; try { href = new URL($(a).attr("href"), src.url).href; } catch { return; }
    if (seen.has(href)) return; seen.add(href);
    out.push({ title, href });
  });
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
    sourceUrl: href, summary: null,
  };
  const ai = await extractWithAI({ title, text, pdfBuf });
  if (ai) for (const k of ["positions", "startDate", "deadline", "eligibility", "applyMode", "applyUrl", "summary"]) {
    if (ai[k]) job[k] = ai[k];            // AI-র তথ্য থাকলে সেটাই (regex-কে ওভাররাইড)
  }
  return job;
}

async function main() {
  const jobs = read(OUT), pending = read(PENDING);
  const known = new Set([...jobs, ...pending].map((j) => j.id));
  let added = 0, queued = 0;

  for (const src of SOURCES) {
    console.log(`▶ ${src.org} — ${src.url}`);
    let links = [];
    try { links = await collectLinks(src); } catch (e) { console.warn("  list fail:", e.message); continue; }
    const fresh = links.filter((l) => !known.has(idOf(l.href))).slice(0, MAX_NEW_PER_SOURCE);
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
    .filter((j) => j.deadline && diffDays(today, j.deadline) <= KEEP_AFTER_DEADLINE)
    .sort((a, b) => (b.posted > a.posted ? 1 : -1));

  fs.writeFileSync(OUT, JSON.stringify(final, null, 2));
  fs.writeFileSync(PENDING, JSON.stringify(pending.slice(-100), null, 2));
  console.log(`✔ jobs=${final.length} (+${added}), pending=${pending.length} (+${queued})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
