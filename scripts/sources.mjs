// প্রতিটি সোর্স: কোন পেজ থেকে লিংক খুঁজবে এবং কোন লিংকগুলো "নিয়োগ বিজ্ঞপ্তি" ধরা হবে।
// ⚠ এগুলো শুরুর নমুনা। প্রতিটি সাইট ব্রাউজারে খুলে URL/include ঠিক আছে কিনা দেখে নিন,
//   না মিললে `selector` দিয়ে লিংক এলাকা সীমাবদ্ধ করুন।
const JOB_WORDS = /নিয়োগ|বিজ্ঞপ্তি|circular|recruitment|vacanc|career|job/i;

// বেসরকারি/প্রাইভেট/NGO বা মিশ্র (সাপ্তাহিক পত্রিকা) লিংক বাদ দেওয়ার শব্দ।
const NOT_GOVT = /private|প্রাইভেট|বেসরকারি|বেসরকারী|ngo|এনজিও|saptahik|সাপ্তাহিক|weekly/;

// JOB_WORDS মিলবে, কিন্তু NOT_GOVT থাকলে মিলবে না।
const GOVT_ONLY = new RegExp(`^(?!.*(?:${NOT_GOVT.source})).*(?:${JOB_WORDS.source})`, "is");

export const SOURCES = [
  // ★ মূল (প্রাইমারি) সোর্স: Teletalk Alljobs (সরকারি)। তালিকার শুরুতে রাখা হয়েছে।
  // type: "teletalk-api" → HTML নয়, সরাসরি JSON API থেকে প্রতিষ্ঠান-ভিত্তিক তালিকা আনে (পেজ JavaScript দিয়ে লোড হয় বলে)।
  // applyUrl দেওয়া নেই, তাই প্রতিটি আইটেমের নিজের লিংকই আবেদন লিংক হবে।
  { org: "টেলিটক (সরকারি চাকরি)", type: "teletalk-api", url: "https://alljobs.teletalk.com.bd/jobs/government",
    api: "https://alljobs.teletalk.com.bd/api/v1/govt-jobs/org-list", limit: 20, maxPages: 5, primary: true },

  // অফিশিয়াল সাইট
  { org: "BPSC",            url: "https://www.bpsc.gov.bd/",          include: /নিয়োগ|বিজ্ঞপ্তি|circular|recruit/i, applyUrl: "https://bpsc.teletalk.com.bd" },
  { org: "বাংলাদেশ ব্যাংক", url: "https://erecruitment.bb.org.bd/",    include: JOB_WORDS, applyUrl: "https://erecruitment.bb.org.bd" },
  { org: "প্রাথমিক ও গণশিক্ষা", url: "https://dpe.gov.bd/",           include: JOB_WORDS, applyUrl: "https://dpe.teletalk.com.bd" },

  // সহায়ক সংকলন সাইট (অফিশিয়াল নয়); আবেদনের আগে পোস্টের ভেতরের অফিশিয়াল লিংক মিলিয়ে নিন।
  // GOVT_ONLY ব্যবহার করা হয়েছে যাতে প্রাইভেট/বেসরকারি চাকরি না আসে।
  { org: "BD Govt Job (সংকলন)",     url: "https://bdgovtjob.net/category/government-jobs-circular/", include: GOVT_ONLY },
  { org: "BD Govt Notice (সংকলন)",  url: "https://bdgovtnotice.com/category/govt-job-circular/",     include: GOVT_ONLY },
  { org: "Bangla Cyber (সংকলন)",    url: "https://www.banglacyber.com/category/govt-job-bd/",        include: GOVT_ONLY },
  // { org: "…", url: "…", selector: ".notice-list", include: JOB_WORDS },
];
