import { useMemo, useState } from "react";
import type { LeftOutRow, PipelineRow } from "../api/types";
import { Drawer, useLiveItem, type DrawerItem } from "../components/Drawer";
import { Banner, Loading, Pill, Stat, StatusPill } from "../components/ui";
import { useData } from "../context/DataContext";
import { useToast } from "../context/ToastContext";
import { useStoredState } from "../hooks/useStoredState";
import { ageText, daysAgo } from "../utils/format";
import { isReviewable, roleFamily, sourceKind } from "../utils/jobs";
import { api } from "../api/endpoints";

/** One line of the list: a drafted row from Jobs_Pipeline, or a row held back in Jobs_Quarantine. */
type Item =
  | { kind: "row"; key: string; row: PipelineRow; role: string; family: string; posted?: string; status: string }
  | { kind: "left-out"; key: string; row: LeftOutRow; role: string; family: string; posted?: string; status: string };

const STATUS_CHIPS: [value: string, label: string][] = [
  ["", "All status"], ["Ready for Review", "Ready for Review"], ["Needs Rewrite", "Needs Rewrite"], ["Approved", "Approved"],
  ["Sent", "Sent"], ["Replied", "Replied"], ["Rejected", "Rejected"], ["Quarantined", "Held back"],
];

interface Filters { family: string; age: string; email: string; src: string; status: string }
const NO_FILTERS: Filters = { family: "", age: "", email: "", src: "", status: "" };

export function JobsPage({ query }: { query: string }) {
  const { rows, leftOut, latestSearch, loading, error, refresh } = useData();
  const toast = useToast();
  const [filters, setFilters] = useStoredState<Filters>("oc-filters", NO_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<DrawerItem>();
  const [busy, setBusy] = useState(false);
  const live = useLiveItem(open);

  const items = useMemo<Item[]>(() => [
    ...rows.filter((r) => r.tab === "Jobs_Pipeline").map((row): Item => {
      const role = row.signal?.role ?? row.subject;
      return { kind: "row", key: `r:${row.email}`, row, role, family: roleFamily(role), posted: row.signal?.posted, status: row.status };
    }),
    ...leftOut.filter((r) => r.tab === "Jobs_Quarantine").map((row, i): Item => ({
      kind: "left-out", key: `q:${row.row_number}:${i}`, row, role: "", family: "Other", status: "Quarantined",
    })),
  ], [rows, leftOut]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      const text = [it.row.company, it.role, it.row.name, it.row.title, it.row.email, it.kind === "left-out" ? it.row.location : ""].join(" ").toLowerCase();
      const age = daysAgo(it.posted);
      const hasEmail = Boolean(it.row.email);
      const src = it.kind === "row" ? sourceKind(it.row) : "";
      return (!q || text.includes(q))
        && (!filters.family || it.family === filters.family)
        && (!filters.age || (age !== undefined && age <= Number(filters.age)))
        && (!filters.email || (filters.email === "none" ? !hasEmail : hasEmail))
        && (!filters.src || src === filters.src)
        && (!filters.status || it.status === filters.status);
    }).sort((a, b) => (b.posted ?? "").localeCompare(a.posted ?? ""));
  }, [items, query, filters]);

  if (loading) return <Loading />;

  const jobRows = items.filter((i): i is Extract<Item, { kind: "row" }> => i.kind === "row");
  const withEmail = items.filter((i) => i.row.email).length;
  const families = [...new Set(items.map((i) => i.family))].sort();
  const today = new Date().toDateString();
  const creditsToday = latestSearch && new Date(latestSearch.started_at).toDateString() === today
    ? latestSearch.result?.seamless_lookups_used ?? latestSearch.progress?.lookups_used ?? 0 : 0;
  const selectedRows = jobRows.filter((i) => selected.has(i.key)).map((i) => i.row);
  const selectable = visible.filter((i) => i.kind === "row");
  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  /** The backend changes one row per call; bulk is one call per selected row. */
  const bulk = async (action: "approve" | "reject") => {
    const eligible = selectedRows.filter((r) => isReviewable(r.status));
    if (!eligible.length) { toast("Only rows in Ready for Review or Needs Rewrite can be changed in bulk.", true); return; }
    if (action === "approve" && !window.confirm(`Approve ${eligible.length} email${eligible.length > 1 ? "s" : ""}? AutoBooker sends them on its next cycles.`)) return;
    setBusy(true);
    let done = 0;
    const failed: string[] = [];
    for (const r of eligible) {
      try { await api[action](r.email); done++; } catch (e) { failed.push(`${r.email}: ${(e as Error).message}`); }
    }
    toast(`${done} ${action === "approve" ? "approved" : "rejected"} in the Sheet${failed.length ? `; ${failed.length} not changed (${failed[0]})` : ""}`, failed.length > 0);
    setSelected(new Set());
    await refresh();
    setBusy(false);
  };

  return (
    <section className="view">
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="stats">
        <Stat hot label="New today" value={items.filter((i) => daysAgo(i.posted) === 0).length} />
        <Stat label="With email" value={withEmail} small={items.length ? `${Math.round((withEmail / items.length) * 100)}%` : undefined} />
        <Stat label="Ready for review" value={jobRows.filter((i) => isReviewable(i.status)).length} />
        <Stat label="Approved, waiting to send" value={jobRows.filter((i) => i.status === "Approved").length} />
        <Stat label="Seamless credits today" value={creditsToday} small="of 10" />
      </div>

      <div className="filters">
        <span className="lbl">Role</span>
        <select value={filters.family} onChange={(e) => setFilters({ ...filters, family: e.target.value })} aria-label="Role">
          <option value="">All families</option>
          {families.map((f) => <option key={f}>{f}</option>)}
        </select>
        <span className="lbl">Posted</span>
        <select value={filters.age} onChange={(e) => setFilters({ ...filters, age: e.target.value })} aria-label="Posted">
          <option value="">Any time</option><option value="1">Last 24 h</option><option value="3">Last 3 days</option><option value="7">Last 7 days</option>
        </select>
        <span className="lbl">Email</span>
        <select value={filters.email} onChange={(e) => setFilters({ ...filters, email: e.target.value })} aria-label="Email">
          <option value="">Any</option><option value="found">Email found</option><option value="none">No email</option>
        </select>
        <span className="lbl">Source</span>
        <select value={filters.src} onChange={(e) => setFilters({ ...filters, src: e.target.value })} aria-label="Source">
          <option value="">Posts and listings</option><option value="post">Posts by a person</option><option value="listing">Job listings</option>
        </select>
        <div className="chips" role="group" aria-label="Status">
          {STATUS_CHIPS.map(([value, label]) => (
            <button key={label} className={`chip${filters.status === value ? " on" : ""}`} onClick={() => setFilters({ ...filters, status: value })}>{label}</button>
          ))}
        </div>
        <button className="clear" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>
      </div>

      <div className="card">
        <div className="tablewrap">
          <table>
            <thead><tr>
              <th><input type="checkbox" aria-label="Select all"
                checked={selectable.length > 0 && selectable.every((i) => selected.has(i.key))}
                onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((i) => i.key)) : new Set())} /></th>
              <th>Posted</th><th>Role they are hiring</th><th>Company</th><th>Contact</th><th>Email</th><th>Status</th><th>Campaign</th>
            </tr></thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={8} className="empty">{items.length ? "No job posts match these filters." : "No job posts yet. Start a search on the Runs page."}</td></tr>
              )}
              {visible.map((it) => it.kind === "row" ? (
                <tr key={it.key} className={`row${open?.row === it.row ? " sel" : ""}`} onClick={() => setOpen({ kind: "row", row: it.row })}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select" checked={selected.has(it.key)} onChange={() => toggle(it.key)} /></td>
                  <td><span className={`age${daysAgo(it.posted) === 0 ? " fresh" : ""}`}>{ageText(it.posted)}</span><div className="src">{sourceKind(it.row)}</div></td>
                  <td><div className="t">{it.role}</div><div className="s">{it.family}</div></td>
                  <td><div className="t">{it.row.company}</div><div className="s">{it.row.domain}</div></td>
                  <td>{it.row.name ? <><div className="t">{it.row.name}</div><div className="s">{it.row.title}</div></> : <span className="s">Not identified</span>}</td>
                  <td><Pill tone="ok">Found</Pill><div className="s mono" style={{ fontSize: 12 }}>{it.row.email}</div></td>
                  <td><StatusPill status={it.status} /></td>
                  <td className="s">Job search</td>
                </tr>
              ) : (
                <tr key={it.key} className="row" onClick={() => setOpen({ kind: "left-out", row: it.row })}>
                  <td />
                  <td><span className="age">-</span><div className="src">held back</div></td>
                  <td><div className="s">Not drafted</div></td>
                  <td><div className="t">{it.row.company}</div><div className="s">{it.row.location}</div></td>
                  <td>{it.row.name ? <><div className="t">{it.row.name}</div><div className="s">{it.row.title}</div></> : <span className="s">Not identified</span>}</td>
                  <td>{it.row.email ? <><Pill tone="warn">Found</Pill><div className="s mono" style={{ fontSize: 12 }}>{it.row.email}</div></> : <Pill tone="bad">None</Pill>}</td>
                  <td><Pill tone="bad">Held back</Pill><div className="s">{it.row.why}</div></td>
                  <td className="s">Job search</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="listfoot">
          <span>{visible.length} of {items.length} job posts</span>
          <span className="hint">Click a row to review. Approving queues the email; AutoBooker sends on its next 15-minute cycle.</span>
          <div className="bulk">
            <button className="btn sm" disabled={!selectedRows.length || busy} onClick={() => bulk("approve")}>Approve selected</button>
            <button className="btn sm" disabled={!selectedRows.length || busy} onClick={() => bulk("reject")}>Reject selected</button>
          </div>
        </div>
      </div>
      <Drawer item={live} onClose={() => setOpen(undefined)} />
    </section>
  );
}
