import { useEffect, useMemo, useState } from "react";
import { Drawer, useLiveItem, type DrawerItem } from "../components/Drawer";
import { Banner, Loading } from "../components/ui";
import { useData } from "../context/DataContext";
import { ageText, firstName, withoutGreeting } from "../utils/format";
import { isReviewable } from "../utils/jobs";

/** One draft at a time from both pipelines. Keyboard: A approve, R reject, E edit, ← → move. */
export function QueuePage() {
  const { rows, loading, error, act } = useData();
  const queue = useMemo(
    () => rows.filter((r) => isReviewable(r.status)).sort((a, b) => (b.signal?.posted ?? "").localeCompare(a.signal?.posted ?? "")),
    [rows],
  );
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState<DrawerItem>();
  const [busy, setBusy] = useState(false);
  const live = useLiveItem(open);
  const pos = Math.min(idx, Math.max(0, queue.length - 1));
  const row = queue[pos];

  const decide = async (action: "approve" | "reject") => {
    if (!row || busy) return;
    setBusy(true);
    try { await act(row, action); } finally { setBusy(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || e.metaKey || e.ctrlKey || e.altKey || /^(input|textarea|select)$/i.test((e.target as HTMLElement).tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "a") void decide("approve");
      else if (k === "r") void decide("reject");
      else if (k === "e" && row) setOpen({ kind: "row", row });
      else if (e.key === "ArrowRight") setIdx(Math.min(pos + 1, queue.length - 1));
      else if (e.key === "ArrowLeft") setIdx(Math.max(0, pos - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (loading) return <Loading />;

  return (
    <section className="view">
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="card" style={{ padding: "14px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div><b>{queue.length ? `${pos + 1} of ${queue.length}` : "0 of 0"}</b> <span className="hint">waiting for a decision. Keyboard: A approve, R reject, E edit, → next.</span></div>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={pos === 0} onClick={() => setIdx(Math.max(0, pos - 1))}>← Previous</button>
        <button className="btn" disabled={pos >= queue.length - 1} onClick={() => setIdx(Math.min(queue.length - 1, pos + 1))}>Next →</button>
      </div>

      <div className="card">
        {!row ? (
          <div className="empty">Nothing waiting. New drafts arrive after a job search (Runs page → Start search).</div>
        ) : (
          <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{row.name || row.email}{row.title ? ` · ${row.title}` : ""}</div>
                <div className="s" style={{ color: "var(--fg-2)" }}>{row.company} · <span className="mono" style={{ fontSize: 12 }}>{row.email}</span> · <span className="tag">{row.tab}</span></div>
              </div>
            </div>
            {row.signal && (
              <div className="signal"><b>They are hiring:</b> {row.signal.role} · posted {ageText(row.signal.posted)}
                {row.signal.url && <> · <a className="mono" href={row.signal.url} target="_blank" rel="noopener noreferrer">{row.signal.url.replace(/^https?:\/\/(www\.)?/, "")}</a></>}
              </div>
            )}
            <div className="draft">
              <div className="subj">Subject: <b>{row.subject}</b></div>
              <div style={{ padding: 12, lineHeight: 1.6, maxWidth: "65ch", whiteSpace: "pre-wrap" }}>
                Hi {firstName(row.name) || "there"},{"\n\n"}{withoutGreeting(row.body)}
                {"\n\n"}<span className="hint">Signature and opt-out line are added by AutoBooker at send time.</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={busy} onClick={() => decide("approve")}>Approve (A)</button>
              <button className="btn" onClick={() => setOpen({ kind: "row", row })}>Edit (E)</button>
              <button className="btn danger" disabled={busy} onClick={() => decide("reject")}>Reject (R)</button>
            </div>
          </div>
        )}
      </div>
      <Drawer item={live} onClose={() => setOpen(undefined)} />
    </section>
  );
}
