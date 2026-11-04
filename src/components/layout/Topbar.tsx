import { useState } from "react";

/** Page title and subtitle, the search box (on list pages), and Refresh from Sheet. */
export function Topbar({ navOpen, onToggleNav, title, subtitle, query, onQuery, showSearch, onRefresh }: {
  navOpen?: boolean;
  onToggleNav?: () => void;
  title: string;
  subtitle: string;
  query: string;
  onQuery: (q: string) => void;
  showSearch: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [syncing, setSyncing] = useState(false);
  return (
    <header className="topbar">
      {onToggleNav && !navOpen && <button type="button" className="burger" onClick={onToggleNav} aria-label="Show menu"><span /><span /><span /></button>}
      <div className="ttl"><h1>{title}</h1><div className="sub">{subtitle}</div></div>
      <div className="grow" />
      {showSearch && (
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search company, role, person, city" aria-label="Search" />
        </label>
      )}
      <button className="btn" disabled={syncing} onClick={async () => { setSyncing(true); await onRefresh(); setSyncing(false); }}>
        {syncing ? "Reading the Sheet…" : "Refresh from Sheet"}
      </button>
    </header>
  );
}
