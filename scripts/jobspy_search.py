"""
Runs one JobSpy search and prints the jobs as JSON on stdout. Called by src/core/jobs/jobspy.ts.

Input: one JSON argument, for example
  {"search_term": "software engineer", "sites": ["indeed", "linkedin"], "location": "USA",
   "hours_old": 72, "results_wanted": 20, "country_indeed": "USA", "proxies": []}
Output: {"jobs": [...], "errors": {"linkedin": "..."}}  or  {"error": "..."} with exit code 1.

Needs Python 3.10+ and:  pip install -U python-jobspy
"""
import json
import sys


def main() -> int:
    # Windows consoles default to cp1252; the engine reads UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        args = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"bad input: {exc}"}))
        return 1
    try:
        import pandas as pd
        from jobspy import scrape_jobs
    except ImportError:
        print(json.dumps({"error": "JobSpy is not installed. Run: pip install -U python-jobspy"}))
        return 1

    try:
        df = scrape_jobs(
            site_name=args.get("sites") or ["indeed", "linkedin"],
            search_term=args.get("search_term") or "hiring",
            location=args.get("location") or None,
            hours_old=args.get("hours_old") or None,
            results_wanted=int(args.get("results_wanted") or 20),
            country_indeed=args.get("country_indeed") or "usa",
            proxies=args.get("proxies") or None,
            description_format="plain",
            verbose=0,
        )
    except Exception as exc:  # one failed search must not crash the engine
        print(json.dumps({"error": f"JobSpy failed: {exc}"}))
        return 1

    keep = ["site", "title", "company", "location", "date_posted", "job_url", "job_url_direct",
            "company_url", "company_url_direct", "is_remote", "description"]
    jobs = []
    for rec in df.to_dict("records"):
        row = {k: rec.get(k) for k in keep if k in rec and not _missing(pd, rec.get(k))}
        if isinstance(row.get("description"), str):
            row["description"] = row["description"][:600]
        jobs.append(row)
    errors = {str(k): str(v) for k, v in (getattr(df, "attrs", {}) or {}).get("errors", {}).items()}
    print(json.dumps({"jobs": jobs, "errors": errors}, default=str, ensure_ascii=False))
    return 0


def _missing(pd, value) -> bool:
    try:
        return value is None or bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


if __name__ == "__main__":
    sys.exit(main())
