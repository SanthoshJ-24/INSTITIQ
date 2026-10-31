import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  Network, FileText, Search, UploadCloud, ShieldCheck, RefreshCw, LayoutDashboard,
  AlertTriangle, CheckCircle2, ChevronRight, Menu, X, FileSearch, Link2, RotateCw,
  XCircle, Info, ArrowRight, Undo2, Loader2, Layers,
} from "lucide-react";
import GraphView, { TYPES, typeColor, typeLabel, relText } from "./GraphView.jsx";
import "./App.css";

const API = "http://127.0.0.1:8000";
const MAX_BYTES = 15 * 1024 * 1024;

const NAV = [
  { id: "overview", name: "Overview", icon: LayoutDashboard, sub: "Your institution's knowledge at a glance." },
  { id: "graph", name: "Knowledge Graph", icon: Network, sub: "Explore how processes, offices, forms and policies connect." },
  { id: "discover", name: "Discover", icon: Search, sub: "Find a process and see who owns it, what it needs and where it is written." },
  { id: "documents", name: "Documents", icon: FileText, sub: "Add source PDFs and track how they were processed." },
  { id: "integrity", name: "Integrity Monitor", icon: ShieldCheck, sub: "Check information that needs a human decision." },
];

const errText = (e, fallback) => {
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d[0]?.msg) return d[0].msg;
  if (!e?.response) return "Can't reach the INSTITIQ API at " + API + ". Start the FastAPI server and try again.";
  return fallback;
};

const parseDate = (s) => (s ? new Date(String(s).includes("T") ? s : String(s).replace(" ", "T") + "Z") : null);
const fmtDate = (s) => {
  const d = parseDate(s);
  if (!d || isNaN(d)) return "Date unavailable";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + ", " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};
const fmtSize = (b) => (b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1024 / 1024).toFixed(1) + " MB");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const num = (v) => (typeof v === "number" ? v : null);

/* ---------- toasts ---------- */
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((kind, text) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);
  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));
  return { toasts, push, dismiss };
}

function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" ? <XCircle size={17} /> : t.kind === "info" ? <Info size={17} /> : <CheckCircle2 size={17} />}
          <span>{t.text}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={15} /></button>
        </div>
      ))}
    </div>
  );
}

/* ---------- small pieces ---------- */
function TypeTag({ type }) {
  return (
    <span className="type-tag">
      <i style={{ background: typeColor(type) }} />
      {typeLabel(type)}
    </span>
  );
}

function Empty({ icon: Icon, title, text, action }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon size={22} /></div>
      <strong>{title}</strong>
      <p>{text}</p>
      {action}
    </div>
  );
}

function Skeleton({ h = 16, w = "100%" }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

function Source({ filename, page }) {
  return (
    <span className="source">
      <FileText size={13} />
      <span className="source-name">{filename || "Unknown document"}</span>
      <span className="source-page">{page != null ? `p. ${page}` : "page unavailable"}</span>
    </span>
  );
}

/* ---------- app ---------- */
export default function App() {
  const initial = () => (NAV.find((n) => n.id === window.location.hash.slice(1)) ? window.location.hash.slice(1) : "overview");
  const [page, setPage] = useState(initial);
  const [menu, setMenu] = useState(false);
  const [online, setOnline] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [reviews, setReviews] = useState([]);
  const { toasts, push, dismiss } = useToasts();

  const refresh = useCallback(async (manual = false) => {
    setRefreshing(true);
    try {
      const [s, d, g, r] = await Promise.all([
        axios.get(`${API}/api/dashboard`),
        axios.get(`${API}/api/documents`),
        axios.get(`${API}/api/graph`),
        axios.get(`${API}/api/reviews`),
      ]);
      setStats(s.data || {});
      setDocuments(Array.isArray(d.data) ? d.data : []);
      setGraph({
        nodes: Array.isArray(g.data?.nodes) ? g.data.nodes : [],
        edges: Array.isArray(g.data?.edges) ? g.data.edges : [],
      });
      setReviews(Array.isArray(r.data) ? r.data : []);
      setOnline(true);
      if (manual) push("success", "Workspace data refreshed.");
    } catch (e) {
      setOnline(false);
      if (manual || !loaded) push("error", errText(e, "Couldn't load workspace data."));
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onHash = () => setPage(initial());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (id) => { window.location.hash = id; setPage(id); setMenu(false); window.scrollTo({ top: 0 }); };
  const current = NAV.find((n) => n.id === page) || NAV[0];
  const pending = reviews.filter((r) => r.status === "Needs Review").length;
  const docMap = useMemo(() => Object.fromEntries(documents.map((d) => [d.id, d])), [documents]);

  const props = { stats, documents, graph, reviews, docMap, refresh, push, go, loaded, online };

  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Network size={20} /></div>
          <div>
            <h2>INSTITIQ</h2>
            <span>Institutional intelligence, connected</span>
          </div>
          <button className="icon-btn mobile-only" onClick={() => setMenu(false)} aria-label="Close menu"><X size={18} /></button>
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <button key={n.id} className={`nav-item ${page === n.id ? "active" : ""}`} onClick={() => go(n.id)} aria-current={page === n.id ? "page" : undefined}>
                <Icon size={17} />
                <span>{n.name}</span>
                {n.id === "integrity" && pending > 0 && <em className="nav-count">{pending}</em>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className={`conn ${online === false ? "down" : online ? "up" : ""}`}>
            <i />
            <div>
              <strong>{online === null ? "Connecting…" : online ? "API connected" : "API unreachable"}</strong>
              <small>{API.replace("http://", "")}</small>
            </div>
          </div>
        </div>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="icon-btn mobile-only" onClick={() => setMenu(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="crumbs">INSTITIQ <ChevronRight size={14} /> <strong>{current.name}</strong></div>
          <div className="topbar-right">
            <span className={`pill ${online === false ? "bad" : online ? "ok" : ""}`}>
              <i />{online === false ? "Offline" : online ? "Online" : "Checking"}
            </span>
            <button className="btn" onClick={() => refresh(true)} disabled={refreshing} title="Reload data from the API">
              <RefreshCw size={15} className={refreshing ? "spin" : ""} /> Refresh
            </button>
          </div>
        </header>

        <main className="content" key={page}>
          <div className="page-head">
            <h1>{current.name}</h1>
            <p>{current.sub}</p>
          </div>
          {online === false && loaded && (
            <div className="banner error">
              <AlertTriangle size={18} />
              <div>
                <strong>The API isn't responding</strong>
                <span>Start the backend with <code>uvicorn main:app --reload</code> on port 8000, then press Refresh.</span>
              </div>
            </div>
          )}
          {page === "overview" && <Overview {...props} />}
          {page === "graph" && <GraphPage {...props} />}
          {page === "discover" && <Discover {...props} />}
          {page === "documents" && <Documents {...props} />}
          {page === "integrity" && <Integrity {...props} />}
        </main>
        <footer className="footer"><span>INSTITIQ</span><span>SRK HACKVERSE 2026</span></footer>
      </div>
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

/* ---------- Overview ---------- */
function Overview({ stats, documents, graph, loaded, go }) {
  const recent = Array.isArray(stats?.recent_documents) ? stats.recent_documents : documents.slice(0, 5);
  const val = (k, alt) => num(stats?.[k]) ?? num(stats?.[alt]);
  const cards = [
    { label: "Documents", value: val("total_documents", "documents"), note: "uploaded PDFs", icon: FileText },
    { label: "Entities", value: val("total_nodes", "nodes"), note: "extracted candidates", icon: Layers },
    { label: "Relationships", value: val("total_edges", "edges"), note: "links between entities", icon: Link2 },
    { label: "Pending review", value: val("pending_reviews", "reviews"), note: "flags need a decision", icon: AlertTriangle, warn: true },
  ];
  const typeCounts = useMemo(() => {
    const c = {};
    graph.nodes.forEach((n) => { const t = String(n.type || "").toLowerCase(); c[t] = (c[t] || 0) + 1; });
    return c;
  }, [graph.nodes]);

  return (
    <>
      <section className="stats">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <div key={c.label} className={`stat ${c.warn && c.value > 0 ? "warn" : ""}`}>
              <div className="stat-top"><span>{c.label}</span><Icon size={16} /></div>
              {!loaded ? <Skeleton h={34} w={70} /> : <strong>{c.value ?? "–"}</strong>}
              <small>{c.note}</small>
            </div>
          );
        })}
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <div><h3>Knowledge graph preview</h3><p>{graph.nodes.length ? `${plural(graph.nodes.length, "entity").replace("entitys", "entities")} and ${plural(graph.edges.length, "relationship")}` : "No entities yet"}</p></div>
            <button className="link" onClick={() => go("graph")}>Open graph <ChevronRight size={15} /></button>
          </div>
          {!loaded ? <Skeleton h={300} /> : graph.nodes.length ? (
            <>
              <div className="graph-frame"><GraphView nodes={graph.nodes} edges={graph.edges} compact height={300} /></div>
              <div className="legend">
                {Object.entries(typeCounts).map(([t, n]) => <span key={t}><i style={{ background: typeColor(t) }} />{typeLabel(t)} <b>{n}</b></span>)}
              </div>
            </>
          ) : (
            <Empty icon={Network} title="The graph is empty" text="Upload a PDF and INSTITIQ will extract processes, departments, forms, documents and policies from it."
              action={<button className="btn primary" onClick={() => go("documents")}>Upload a document</button>} />
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div><h3>Recent documents</h3><p>Latest uploads</p></div>
            <button className="link" onClick={() => go("documents")}>All documents <ChevronRight size={15} /></button>
          </div>
          {!loaded ? <div className="stack"><Skeleton h={44} /><Skeleton h={44} /><Skeleton h={44} /></div> : recent.length ? (
            <ul className="doc-list">
              {recent.map((d) => (
                <li key={d.id}>
                  <div className="file-ico"><FileText size={17} /></div>
                  <div className="grow">
                    <strong title={d.filename}>{d.filename}</strong>
                    <small>{plural(d.pages ?? 0, "page")} · {plural(d.extracted_count ?? 0, "entity").replace("entitys", "entities")} · {fmtDate(d.created_at)}</small>
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty icon={FileSearch} title="No documents yet" text="Documents you upload will appear here." />}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><div><h3>Quick actions</h3></div></div>
        <div className="actions">
          <button className="action" onClick={() => go("documents")}><UploadCloud size={20} /><div><strong>Upload documents</strong><span>Add a source PDF to the graph</span></div><ArrowRight size={16} /></button>
          <button className="action" onClick={() => go("discover")}><Search size={20} /><div><strong>Discover a process</strong><span>Search by name or keyword</span></div><ArrowRight size={16} /></button>
          <button className="action" onClick={() => go("integrity")}><ShieldCheck size={20} /><div><strong>Review flags</strong><span>Decide on flagged pages</span></div><ArrowRight size={16} /></button>
        </div>
      </section>
    </>
  );
}

/* ---------- Knowledge Graph ---------- */
function GraphPage({ graph, docMap, loaded, go }) {
  const [visible, setVisible] = useState(new Set(Object.keys(TYPES)));
  const [selected, setSelected] = useState(null);
  const [selectedDetails, setSelectedDetails] = useState(null);
  const [detailsError, setDetailsError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const nodeMap = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const counts = useMemo(() => {
    const c = {};
    graph.nodes.forEach((n) => { const t = String(n.type || "").toLowerCase(); c[t] = (c[t] || 0) + 1; });
    return c;
  }, [graph.nodes]);
  const typeKeys = useMemo(() => Array.from(new Set([...Object.keys(TYPES), ...Object.keys(counts)])), [counts]);

  useEffect(() => {
    setVisible((v) => { const n = new Set(v); typeKeys.forEach((t) => { if (!(t in TYPES)) n.add(t); }); return n; });
  }, [typeKeys]);

  const toggle = (t) => setVisible((v) => {
    const n = new Set(v);
    if (n.has(t)) n.delete(t);
    else n.add(t);
    return n;
  });

  const sel = selected ? nodeMap.get(selected) : null;
  useEffect(() => {
    if (!selected) {
      setSelectedDetails(null);
      setDetailsError("");
      return;
    }

    let active = true;
    setDetailsLoading(true);
    setDetailsError("");
    axios.get(`${API}/api/graph/nodes/${encodeURIComponent(selected)}`)
      .then((response) => {
        if (active) setSelectedDetails(response.data || null);
      })
      .catch((error) => {
        if (active) {
          setSelectedDetails(null);
          setDetailsError(errText(error, "Could not load node details."));
        }
      })
      .finally(() => {
        if (active) setDetailsLoading(false);
      });

    return () => { active = false; };
  }, [selected]);
  const rels = useMemo(() => {
    if (!sel) return [];
    return graph.edges
      .filter((e) => e.source === sel.id || e.target === sel.id)
      .map((e) => {
        const out = e.source === sel.id;
        const other = nodeMap.get(out ? e.target : e.source);
        return { ...e, out, other, filename: docMap[e.document_id]?.filename };
      });
  }, [sel, graph.edges, nodeMap, docMap]);

  const sources = useMemo(() => {
    if (!sel) return [];
    const m = new Map();
    rels.forEach((r) => { if (r.document_id != null) m.set(`${r.document_id}|${r.page_number}`, r); });
    return Array.from(m.values()).sort((a, b) => (a.filename || "").localeCompare(b.filename || "") || (a.page_number ?? 0) - (b.page_number ?? 0));
  }, [sel, rels]);

  if (!loaded) return <div className="panel"><Skeleton h={480} /></div>;
  if (!graph.nodes.length)
    return <div className="panel"><Empty icon={Network} title="No graph data yet" text="The graph is built from your uploaded PDFs. Nothing is added unless it was extracted from a source."
      action={<button className="btn primary" onClick={() => go("documents")}>Upload a document</button>} /></div>;

  const unevidenced = graph.edges.filter((e) => e.document_id == null || e.page_number == null).length;

  return (
    <div className="graph-layout">
      <section className="panel graph-panel">
        <div className="filters" role="group" aria-label="Filter by entity type">
          {typeKeys.map((t) => (
            <button key={t} className={`chip ${visible.has(t) ? "on" : ""}`} onClick={() => toggle(t)} aria-pressed={visible.has(t)}>
              <i style={{ background: typeColor(t) }} />{typeLabel(t)}<b>{counts[t] || 0}</b>
            </button>
          ))}
        </div>
        <div className="graph-frame tall">
          <GraphView nodes={graph.nodes} edges={graph.edges} visibleTypes={visible} selectedId={selected} onSelect={setSelected} height={560} />
        </div>
        <div className="graph-note">
          <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="#64748b" strokeWidth="1.5" /></svg> Linked to a source page</span>
          <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="#64748b" strokeWidth="1.5" strokeDasharray="4 3" /></svg> No source recorded{unevidenced ? ` (${unevidenced})` : ""}</span>
          <span>Scroll to zoom · drag to pan · click a node for details</span>
        </div>
      </section>

      <aside className="panel details" aria-live="polite">
        {!sel ? (
          <Empty icon={Network} title="Select an entity" text="Click any node to see its connections and the document pages it was extracted from." />
        ) : detailsLoading ? (
          <div className="stack"><Skeleton h={22} w="60%" /><Skeleton h={14} /><Skeleton h={14} w="80%" /></div>
        ) : detailsError ? (
          <div className="banner error"><AlertTriangle size={18} /><div><strong>Details unavailable</strong><span>{detailsError}</span></div></div>
        ) : (
          <>
            <div className="details-head">
              <TypeTag type={selectedDetails?.type || sel.type} />
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close details"><X size={16} /></button>
            </div>
            <h3>{selectedDetails?.label || sel.label}</h3>
            <p className="muted">{selectedDetails?.description || sel.description || "No description recorded."}</p>
            <div className="status-line"><AlertTriangle size={14} /> Extracted candidate. Verify it against the source page.</div>

            <h4>Connections ({rels.length})</h4>
            {rels.length === 0 ? <p className="muted small">No relationships recorded for this entity.</p> : (
              <ul className="rel-list">
                {rels.map((r, i) => (
                  <li key={i}>
                    <button onClick={() => r.other && setSelected(r.other.id)} disabled={!r.other}>
                      <span className="rel-dir">{r.out ? "" : "← "}{relText(r.relation)}{r.out ? " →" : ""}</span>
                      <strong>{r.other?.label || "Unknown entity"}</strong>
                      {r.other && <TypeTag type={r.other.type} />}
                    </button>
                    {r.document_id != null && r.page_number != null
                      ? <Source filename={r.filename} page={r.page_number} />
                      : <span className="no-source">No source recorded</span>}
                  </li>
                ))}
              </ul>
            )}

            <h4>Source pages ({selectedDetails?.sources?.length || sources.length})</h4>
            {(selectedDetails?.sources?.length || sources.length) === 0
              ? <p className="muted small">No source page is recorded for this entity.</p>
              : <div className="stack-sm">
                {(selectedDetails?.sources?.length ? selectedDetails.sources : sources)
                  .map((s, i) => <Source key={i} filename={s.filename} page={s.page_number} />)}
              </div>}
          </>
        )}
      </aside>
    </div>
  );
}

/* ---------- Discover ---------- */
function Discover({ push, online }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [state, setState] = useState({ status: "idle", matches: [], total: 0, ran: "" });

  async function run(q, cat) {
    const text = q.trim();
    if (!text) { push("info", "Enter a process, department, form, document or policy to search."); return; }
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const res = await axios.post(`${API}/api/search`, { query: text, category: cat || null });
      const matches = (Array.isArray(res.data?.matches) ? res.data.matches : [])
        .filter((m) => m && typeof m === "object")
        .map((m, i) => ({
          id: m.id ?? `r${i}`,
          label: typeof m.label === "string" ? m.label : "Unnamed item",
          type: m.type || m.kind || "",
          description: typeof m.description === "string" ? m.description : "",
          connections: Array.isArray(m.connections) ? m.connections.filter((c) => c && typeof c === "object") : [],
          sources: Array.isArray(m.sources) ? m.sources.filter((s) => s && typeof s === "object") : [],
        }));
      setState({ status: "done", matches, total: res.data?.total ?? matches.length, ran: text });
    } catch (e) {
      setState({ status: "error", matches: [], total: 0, ran: text, error: errText(e, "The search couldn't be completed.") });
    }
  }

  const submit = (e) => { e.preventDefault(); run(query, category); };
  const pick = (t) => { setCategory(t); if (state.status !== "idle" && query.trim()) run(query, t); };

  return (
    <>
      <form className="search-box" onSubmit={submit} role="search">
        <Search size={22} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a process, department, form, document or policy" aria-label="Search institutional knowledge" autoFocus />
        <button className="btn primary lg" type="submit" disabled={state.status === "loading" || online === false}>
          {state.status === "loading" ? <><Loader2 size={16} className="spin" /> Searching</> : "Search"}
        </button>
      </form>
      <div className="filters left" role="group" aria-label="Filter by type">
        <button className={`chip ${category === "" ? "on" : ""}`} onClick={() => pick("")}>All types</button>
        {Object.entries(TYPES).map(([k, v]) => (
          <button key={k} className={`chip ${category === k ? "on" : ""}`} onClick={() => pick(k)}><i style={{ background: v.color }} />{v.label}</button>
        ))}
      </div>

      {state.status === "idle" && <div className="panel"><Empty icon={Search} title="Start with a keyword" text="Try a process such as “course registration”, or a form or office name. Results come only from your uploaded documents." /></div>}
      {state.status === "loading" && <div className="stack">{[0, 1, 2].map((i) => <div className="panel" key={i}><Skeleton h={18} w="40%" /><div style={{ height: 10 }} /><Skeleton h={14} /><div style={{ height: 8 }} /><Skeleton h={14} w="70%" /></div>)}</div>}
      {state.status === "error" && <div className="banner error"><AlertTriangle size={18} /><div><strong>Search failed</strong><span>{state.error}</span></div><button className="btn" onClick={() => run(query, category)}>Try again</button></div>}
      {state.status === "done" && state.matches.length === 0 && <div className="panel"><Empty icon={FileSearch} title={`No results for “${state.ran}”`} text={category ? "Try the All types filter, a shorter keyword, or upload a document that covers this topic." : "Try a shorter keyword, or upload a document that covers this topic."} /></div>}
      {state.status === "done" && state.matches.length > 0 && (
        <>
          <p className="result-count">{plural(state.total, "result")} for “{state.ran}”</p>
          <div className="stack">
            {state.matches.map((m) => (
              <article className="result" key={m.id}>
                <div className="result-head"><TypeTag type={m.type} /><h3>{m.label}</h3></div>
                <p className="muted">{m.description || "No description recorded."}</p>
                {m.connections.length > 0 && (
                  <div className="result-block">
                    <h4>Connected to</h4>
                    <div className="conns">
                      {m.connections.map((c, i) => (
                        <span className="conn-chip" key={i}>
                          <i style={{ background: typeColor(c.type) }} />
                          <em>{relText(c.relation)}</em>
                          {typeof c.label === "string" && c.label ? c.label : "Related item"}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="result-block">
                  <h4>Found in</h4>
                  {m.sources.length ? (
                    <div className="stack-sm">{m.sources.map((s, i) => <Source key={i} filename={s.filename} page={s.page_number ?? s.page} />)}</div>
                  ) : <span className="no-source">No source page recorded</span>}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ---------- Documents ---------- */
function Documents({ documents, push, refresh, loaded, online }) {
  const [drag, setDrag] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [reprocessing, setReprocessing] = useState(null);
  const input = useRef(null);

  const patch = (key, p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function uploadOne(file) {
    const key = Math.random().toString(36).slice(2);
    const base = { key, name: file.name, size: file.size };
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploads((u) => [{ ...base, status: "error", message: "Only PDF files are supported." }, ...u]);
      push("error", `${file.name}: only PDF files are supported.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploads((u) => [{ ...base, status: "error", message: "File exceeds the 15 MB limit." }, ...u]);
      push("error", `${file.name}: file exceeds the 15 MB limit.`);
      return;
    }
    setUploads((u) => [{ ...base, status: "uploading", progress: 0 }, ...u]);
    const data = new FormData();
    data.append("file", file);
    try {
      const res = await axios.post(`${API}/api/documents/upload`, data, {
        onUploadProgress: (e) => e.total && patch(key, { progress: Math.round((e.loaded / e.total) * 100) }),
      });
      const r = res.data || {};
      if (r.duplicate) {
        patch(key, { status: "duplicate", message: r.message || "This document has already been uploaded." });
        push("info", `${file.name} was already uploaded.`);
      } else {
        patch(key, { status: "done", pages: r.pages, entities: r.extracted_entities, pagesWith: r.pages_with_entities });
        push("success", `${file.name} processed: ${plural(r.extracted_entities ?? 0, "entity").replace("entitys", "entities")} extracted.`);
      }
      await refresh();
    } catch (e) {
      const m = errText(e, "Document upload failed.");
      patch(key, { status: "error", message: m });
      push("error", `${file.name}: ${m}`);
    }
  }

  async function addFiles(list) {
    const files = Array.from(list || []);
    for (const f of files) await uploadOne(f);
  }

  async function reprocess(doc) {
    setReprocessing(doc.id);
    try {
      const res = await axios.post(`${API}/api/documents/${doc.id}/reprocess`);
      push("success", `${doc.filename} reprocessed: ${plural(res.data?.extracted_entities ?? 0, "entity").replace("entitys", "entities")}, ${plural(res.data?.review_flags ?? 0, "review flag")}.`);
      await refresh();
    } catch (e) {
      push("error", errText(e, "Reprocessing failed."));
      await refresh();
    } finally { setReprocessing(null); }
  }

  const busy = uploads.some((u) => u.status === "uploading");

  return (
    <>
      <div
        className={`dropzone ${drag ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
      >
        <div className="drop-ico"><UploadCloud size={26} /></div>
        <strong>Drag PDF files here</strong>
        <span>PDF only · up to 15 MB and 300 pages each</span>
        <button className="btn primary" onClick={() => input.current?.click()} disabled={online === false}>Browse files</button>
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </div>
      <div className="callout"><Info size={16} /> Extraction is rule-based, so entities are candidates. Check them against the source page before relying on them.</div>

      {uploads.length > 0 && (
        <section className="panel">
          <div className="panel-head"><div><h3>This session's uploads</h3><p>{busy ? "Processing…" : `${uploads.length} file${uploads.length === 1 ? "" : "s"}`}</p></div>
            {!busy && <button className="link" onClick={() => setUploads([])}>Clear</button>}</div>
          <ul className="upload-list">
            {uploads.map((u) => (
              <li key={u.key} className={u.status}>
                <div className="file-ico"><FileText size={17} /></div>
                <div className="grow">
                  <strong title={u.name}>{u.name}</strong>
                  <small>
                    {fmtSize(u.size)}
                    {u.status === "done" && ` · ${plural(u.pages ?? 0, "page")} · ${plural(u.entities ?? 0, "entity").replace("entitys", "entities")} (${u.pagesWith ?? 0} pages with matches)`}
                    {(u.status === "error" || u.status === "duplicate") && ` · ${u.message}`}
                  </small>
                  {u.status === "uploading" && <div className="progress"><div style={{ width: `${u.progress ?? 0}%` }} /></div>}
                </div>
                <span className={`badge ${u.status}`}>
                  {u.status === "uploading" ? (u.progress === 100 ? "Processing" : `${u.progress ?? 0}%`) : u.status === "done" ? "Processed" : u.status === "duplicate" ? "Duplicate" : "Failed"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><div><h3>Document library</h3><p>{plural(documents.length, "document")}</p></div></div>
        {!loaded ? <div className="stack"><Skeleton h={44} /><Skeleton h={44} /></div> : documents.length === 0 ? (
          <Empty icon={FileText} title="No documents yet" text="Upload a PDF to start building the knowledge graph." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Document</th><th>Status</th><th className="r">Pages</th><th className="r">Entities</th><th>Uploaded</th><th /></tr></thead>
              <tbody>
                {documents.map((d) => {
                  const st = String(d.processing_status || "processed").toLowerCase();
                  const isBusy = reprocessing === d.id || st === "processing";
                  return (
                    <tr key={d.id}>
                      <td><div className="cell-doc"><FileText size={16} /><div><strong title={d.filename}>{d.filename}</strong><small>ID {d.id}</small></div></div></td>
                      <td><span className={`badge ${isBusy ? "uploading" : st === "failed" ? "error" : "done"}`}>{isBusy ? "Processing" : st === "failed" ? "Failed" : "Processed"}</span></td>
                      <td className="r">{d.pages ?? "–"}</td>
                      <td className="r">{d.extracted_count ?? "–"}</td>
                      <td className="nowrap">{fmtDate(d.created_at)}</td>
                      <td className="r"><button className="btn sm" onClick={() => reprocess(d)} disabled={isBusy} title="Re-run extraction on the stored PDF">
                        <RotateCw size={13} className={isBusy ? "spin" : ""} /> Reprocess</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ---------- Integrity ---------- */
const STATUS = {
  "Needs Review": { cls: "review", label: "Needs review" },
  Verified: { cls: "verified", label: "Verified" },
  Dismissed: { cls: "dismissed", label: "Dismissed" },
};

function Integrity({ reviews, docMap, refresh, push, loaded }) {
  const [filter, setFilter] = useState("Needs Review");
  const [busyId, setBusyId] = useState(null);
  const counts = useMemo(() => {
    const c = { all: reviews.length, "Needs Review": 0, Verified: 0, Dismissed: 0 };
    reviews.forEach((r) => { if (r.status in c) c[r.status]++; });
    return c;
  }, [reviews]);
  const list = filter === "all" ? reviews : reviews.filter((r) => r.status === filter);

  async function setStatus(r, status) {
    setBusyId(r.id);
    try {
      await axios.patch(`${API}/api/reviews/${r.id}`, { status });
      push("success", status === "Needs Review" ? "Flag moved back to review." : `Flag marked ${status.toLowerCase()}.`);
      await refresh();
    } catch (e) {
      push("error", errText(e, "Couldn't update the review flag."));
    } finally { setBusyId(null); }
  }

  const tabs = [["Needs Review", "Needs review"], ["Verified", "Verified"], ["Dismissed", "Dismissed"], ["all", "All"]];

  return (
    <>
      <div className={`banner ${counts["Needs Review"] ? "warn" : "ok"}`}>
        {counts["Needs Review"] ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
        <div>
          <strong>{counts["Needs Review"] ? `${plural(counts["Needs Review"], "flag")} awaiting review` : "Nothing is waiting for review"}</strong>
          <span>A flag marks a page where extraction found process-related text but no structured entities. It does not mean information is outdated. Nothing here has been confirmed outdated.</span>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={`tab ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{l}<b>{counts[k]}</b></button>
        ))}
      </div>

      {!loaded ? <div className="stack"><div className="panel"><Skeleton h={60} /></div></div> : list.length === 0 ? (
        <div className="panel"><Empty icon={ShieldCheck} title={reviews.length ? "No flags in this view" : "No review flags"} text={reviews.length ? "Switch tabs to see flags with another status." : "Flags appear when a document page needs a human to check it."} /></div>
      ) : (
        <div className="stack">
          {list.map((r) => {
            const st = STATUS[r.status] || { cls: "review", label: r.status || "Unknown" };
            const filename = r.filename || docMap[r.document_id]?.filename;
            return (
              <article className="flag" key={r.id}>
                <div className="flag-head">
                  <h3>{r.title}</h3>
                  <span className={`status ${st.cls}`}>{st.label}</span>
                </div>
                <p className="muted" style={{ whiteSpace: "pre-line" }}>{r.reason}</p>
                <div className="flag-foot">
                  {r.document_id ? <Source filename={filename} page={r.page_number} /> : <span className="no-source">No source recorded</span>}
                  <span className="muted small">Flagged {fmtDate(r.created_at)}</span>
                  <div className="flag-actions">
                    {r.status === "Needs Review" ? (
                      <>
                        <button className="btn sm primary" onClick={() => setStatus(r, "Verified")} disabled={busyId === r.id}><CheckCircle2 size={14} /> Verify</button>
                        <button className="btn sm" onClick={() => setStatus(r, "Dismissed")} disabled={busyId === r.id}><X size={14} /> Dismiss</button>
                      </>
                    ) : (
                      <button className="btn sm" onClick={() => setStatus(r, "Needs Review")} disabled={busyId === r.id}><Undo2 size={14} /> Reopen for review</button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
