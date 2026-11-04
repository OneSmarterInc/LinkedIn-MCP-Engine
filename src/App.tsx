import { useCallback, useEffect, useState } from "react";
import { ApiError, getToken, setToken } from "./api/client";
import { api } from "./api/endpoints";
import { Rail } from "./components/layout/Rail";
import { Topbar } from "./components/layout/Topbar";
import { Banner, Loading } from "./components/ui";
import { DataProvider, useData } from "./context/DataContext";
import { ToastProvider } from "./context/ToastContext";
import { useHashRoute } from "./hooks/useHashRoute";
import { AutomationPage } from "./pages/AutomationPage";
import { CampaignsPage } from "./pages/campaigns/CampaignsPage";
import { JobsPage } from "./pages/JobsPage";
import { PipelinePage } from "./pages/PipelinePage";
import { QueuePage } from "./pages/QueuePage";
import { RunsPage } from "./pages/RunsPage";
import { PAGE_INFO, PAGES } from "./pages/routes";

/** Checks the backend first: is it running, and does it need a token? Then shows the console. */
export function App() {
  const [state, setState] = useState<"checking" | "down" | "token" | "ready">("checking");
  const [message, setMessage] = useState("");

  const check = useCallback(async () => {
    setState("checking");
    try {
      const health = await api.health();
      if (health.auth) {
        if (!getToken()) { setState("token"); return; }
        try { await api.summary(); } catch (e) { if (e instanceof ApiError && e.status === 401) { setState("token"); return; } }
      }
      setState("ready");
    } catch (e) {
      setMessage((e as Error).message);
      setState("down");
    }
  }, []);
  useEffect(() => { void check(); }, [check]);

  if (state === "checking") return <Loading text="Connecting to the backend…" />;
  if (state === "down") {
    return <div style={{ padding: 24, maxWidth: 640 }}><Banner tone="bad" action={<button className="btn" onClick={check}>Try again</button>}>{message}</Banner></div>;
  }
  if (state === "token") return <TokenGate onDone={check} />;
  return <ToastProvider><DataProvider><Console /></DataProvider></ToastProvider>;
}

/** Shown when the backend has API_TOKEN set. The token stays in this browser. */
function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState(getToken());
  return (
    <div style={{ padding: 24, maxWidth: 440, display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>Outreach Console</h1>
      <p className="hint">This backend asks for a token. Paste the API_TOKEN from the backend's .env file. It is kept in this browser only.</p>
      <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); setToken(value.trim()); onDone(); }}>
        <input type="password" autoFocus aria-label="API token" value={value} onChange={(e) => setValue(e.target.value)}
          style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 6 }} />
        <button className="btn primary" type="submit" disabled={!value.trim()}>Continue</button>
      </form>
    </div>
  );
}

/** The layout from the design: rail on the left, top bar, and the current page. */
function Console() {
  const { refresh } = useData();
  const page = useHashRoute(PAGES, "jobs");
  const [query, setQuery] = useState("");
  const [campaignCount, setCampaignCount] = useState<number>();
  const [runningCount, setRunningCount] = useState(0);
  const info = PAGE_INFO[page];
  // Sidebar open/closed. Remembered per browser; starts closed on narrow screens.
  const [navOpen, setNavOpen] = useState<boolean>(() => {
    try { const v = localStorage.getItem("nav-open"); if (v) return v === "1"; } catch { /* private window */ }
    return !window.matchMedia("(max-width: 860px)").matches;
  });
  const toggleNav = () => setNavOpen((v) => { try { localStorage.setItem("nav-open", v ? "0" : "1"); } catch { /* ignore */ } return !v; });
  const closeNavOnMobile = () => { if (window.matchMedia("(max-width: 860px)").matches) setNavOpen(false); };

  useEffect(() => { document.title = `${info.title} · Outreach Console`; }, [info.title]);
  useEffect(() => { api.campaigns().then((c) => setCampaignCount(c.campaigns.length)).catch(() => {}); }, []);

  return (
    <div className={`app ${navOpen ? "nav-open" : "nav-closed"}`}>
      {navOpen && <div className="navscrim" onClick={() => setNavOpen(false)} />}
      <Rail page={page} campaignCount={campaignCount} runningCount={runningCount} onToggle={toggleNav} onNavigate={closeNavOnMobile} />
      <div className="main">
        <Topbar
          navOpen={navOpen} onToggleNav={toggleNav}
          title={info.title} subtitle={info.subtitle}
          query={query} onQuery={setQuery} showSearch={page === "jobs" || page === "pipeline"}
          onRefresh={() => refresh(true)}
        />
        <main className="content">
          {page === "jobs" && <JobsPage query={query} />}
          {page === "queue" && <QueuePage />}
          {page === "pipeline" && <PipelinePage query={query} />}
          {page === "campaigns" && <CampaignsPage onCount={setCampaignCount} />}
          {page === "runs" && <RunsPage onRunning={setRunningCount} />}
          {page === "automation" && <AutomationPage />}
        </main>
      </div>
    </div>
  );
}
