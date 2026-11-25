// নির্ভরতা-মুক্ত সহায়ক ফাংশন (বাংলা সংখ্যা/তারিখ পার্সিং)
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
export const toEnDigits = (s) => String(s).replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d));

const MONTHS = {
  jan: 1, january: 1, "জানুয়ারি": 1, "জানুয়ারী": 1,
  feb: 2, february: 2, "ফেব্রুয়ারি": 2, "ফেব্রুয়ারী": 2,
  mar: 3, march: 3, "মার্চ": 3,
  apr: 4, april: 4, "এপ্রিল": 4,
  may: 5, "মে": 5,
  jun: 6, june: 6, "জুন": 6,
  jul: 7, july: 7, "জুলাই": 7,
  aug: 8, august: 8, "আগস্ট": 8, "আগষ্ট": 8,
  sep: 9, sept: 9, september: 9, "সেপ্টেম্বর": 9,
  oct: 10, october: 10, "অক্টোবর": 10,
  nov: 11, november: 11, "নভেম্বর": 11,
  dec: 12, december: 12, "ডিসেম্বর": 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const pad = (n) => String(n).padStart(2, "0");
const valid = (y, m, d) => y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
const iso = (y, m, d) => (valid(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);

// টেক্সটের ভেতর প্রথম তারিখ খুঁজে YYYY-MM-DD দেয় (না পেলে null)
export function findDate(text) {
  const t = toEnDigits(text || "");
  let m = t.match(/(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})/);
  if (m) return iso(+m[3], +m[2], +m[1]); // dd/mm/yyyy (বাংলাদেশি ফরম্যাট)
  m = t.match(new RegExp(`(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*[,\\-]?\\s*(${MONTH_RE})\\.?\\s*[,\\-]?\\s*(\\d{4})`, "i"));
  if (m) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}

// "আবেদনের শেষ তারিখ ... ২০ ডিসেম্বর ২০২৬" ধরনের বাক্য থেকে ডেডলাইন
export function findDeadline(text) {
  const t = toEnDigits(text || "").replace(/\s+/g, " ");
  const re = /(শেষ\s*তারিখ|আবেদনের\s*শেষ|আবেদন\s*করার\s*শেষ|last\s*date|deadline|closing\s*date|till|until)/gi;
  let m;
  while ((m = re.exec(t))) {
    const d = findDate(t.slice(m.index, m.index + 90));
    if (d) return d;
  }
  return null;
}

export function findStart(text) {
  const t = toEnDigits(text || "").replace(/\s+/g, " ");
  const m = /(আবেদন\s*শুরু|শুরুর\s*তারিখ|start(?:ing)?\s*date|application\s*start)/i.exec(t);
  return m ? findDate(t.slice(m.index, m.index + 90)) : null;
}

export function findPositions(text) {
  const t = toEnDigits(text || "");
  const m = t.match(/(?:পদ\s*সংখ্যা|পদের\s*সংখ্যা|মোট\s*পদ|total\s*(?:posts?|vacanc(?:y|ies))|vacanc(?:y|ies))\D{0,20}([\d,]+\+?)/i);
  return m ? m[1] : null;
}

export const todayDhaka = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
export const addDays = (key, n) => {
  const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
export const diffDays = (a, b) => Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);
