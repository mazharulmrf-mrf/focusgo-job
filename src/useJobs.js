import { useEffect, useState } from "react";

// ⚠ নিজের USER/REPO বসান। raw.githubusercontent.com CORS খোলা রাখে, তাই ব্রাউজার থেকে সরাসরি fetch চলে।
// (রিপো public হতে হবে। private হলে GitHub Pages বা Cloudflare Pages থেকে serve করুন।)
const JOBS_URL = "https://raw.githubusercontent.com/USER/REPO/main/public/jobs.json";
const CACHE_KEY = "focusgo_jobs_cache";

export default function useJobs() {
  const [jobs, setJobs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let off = false;
    fetch(`${JOBS_URL}?t=${Math.floor(Date.now() / 600000)}`)   // ১০ মিনিটে একবার cache-bust
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((d) => {
        if (off || !Array.isArray(d)) return;
        setJobs(d); setError(false);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch {}
      })
      .catch(() => { if (!off) setError(true); })   // অফলাইনে ক্যাশ থাকা ডেটাই দেখাবে
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, []);

  return { jobs, loading, error };
}
