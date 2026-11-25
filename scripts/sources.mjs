// প্রতিটি সোর্স: কোন পেজ থেকে লিংক খুঁজবে এবং কোন লিংকগুলো "নিয়োগ বিজ্ঞপ্তি" ধরা হবে।
// ⚠ এগুলো শুরুর নমুনা। প্রতিটি সাইট ব্রাউজারে খুলে URL/include ঠিক আছে কিনা দেখে নিন,
//   না মিললে `selector` দিয়ে লিংক এলাকা সীমাবদ্ধ করুন।
const JOB_WORDS = /নিয়োগ|বিজ্ঞপ্তি|circular|recruitment|vacanc|career|job/i;

export const SOURCES = [
  { org: "BPSC",            url: "https://www.bpsc.gov.bd/",          include: /নিয়োগ|বিজ্ঞপ্তি|circular|recruit/i, applyUrl: "https://bpsc.teletalk.com.bd" },
  { org: "বাংলাদেশ ব্যাংক", url: "https://erecruitment.bb.org.bd/",    include: JOB_WORDS, applyUrl: "https://erecruitment.bb.org.bd" },
  { org: "প্রাথমিক ও গণশিক্ষা", url: "https://dpe.gov.bd/",           include: JOB_WORDS, applyUrl: "https://dpe.teletalk.com.bd" },
  // Teletalk-এর সব চাকরির পোর্টাল (একাধিক প্রতিষ্ঠান)। applyUrl দেওয়া নেই, তাই প্রতিটি আইটেমের নিজের লিংকই আবেদন লিংক হবে।
  { org: "টেলিটক (সকল চাকরি)", url: "https://alljobs.teletalk.com.bd/jobs/government", include: JOB_WORDS },
  // { org: "…", url: "…", selector: ".notice-list", include: JOB_WORDS },
];
