import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCcw } from "lucide-react";

export const TYPES = {
  process: { label: "Process", color: "#2b5fd9" },
  department: { label: "Department", color: "#7a4fc9" },
  form: { label: "Form", color: "#12877b" },
  document: { label: "Document", color: "#b7791f" },
  policy: { label: "Policy", color: "#c2410c" },
};
export const typeColor = (t) => TYPES[String(t || "").toLowerCase()]?.color || "#64748b";
export const typeLabel = (t) => TYPES[String(t || "").toLowerCase()]?.label || (t ? String(t) : "Entity");
export const relText = (r) => String(r || "related to").replaceAll("_", " ");

const W = 1000, H = 640;

function layout(nodes, edges) {
  const n = nodes.length;
  const pos = nodes.map((node, i) => {
    const a = (2 * Math.PI * i) / Math.max(n, 1);
    const r = 120 + (i % 7) * 28;
    return { id: node.id, x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
  });
  const idx = new Map(pos.map((p, i) => [p.id, i]));
  const links = edges
    .map((e) => [idx.get(e.source), idx.get(e.target)])
    .filter(([a, b]) => a !== undefined && b !== undefined);
  const iterations = n > 250 ? 120 : 260;
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 90000) continue;
        const f = 2600 / d2, d = Math.sqrt(d2);
        dx = (dx / d) * f; dy = (dy / d) * f;
        pos[i].vx += dx; pos[i].vy += dy; pos[j].vx -= dx; pos[j].vy -= dy;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - 90) * 0.02;
      pos[a].vx += (dx / d) * f; pos[a].vy += (dy / d) * f;
      pos[b].vx -= (dx / d) * f; pos[b].vy -= (dy / d) * f;
    }
    for (const p of pos) {
      p.vx += (W / 2 - p.x) * 0.004; p.vy += (H / 2 - p.y) * 0.004;
      p.x += Math.max(-12, Math.min(12, p.vx)) * cool;
      p.y += Math.max(-12, Math.min(12, p.vy)) * cool;
      p.vx *= 0.6; p.vy *= 0.6;
    }
  }
  return new Map(pos.map((p) => [p.id, { x: p.x, y: p.y }]));
}

export default function GraphView({ nodes, edges, visibleTypes, selectedId, onSelect, compact = false, height = 440 }) {
  const svgRef = useRef(null);
  const drag = useRef(null);
  const [tf, setTf] = useState({ k: 1, x: 0, y: 0 });

  const positions = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const shownNodes = useMemo(
    () => nodes.filter((n) => !visibleTypes || visibleTypes.has(String(n.type).toLowerCase())),
    [nodes, visibleTypes]
  );
  const shownIds = useMemo(() => new Set(shownNodes.map((n) => n.id)), [shownNodes]);
  const shownEdges = useMemo(
    () => edges.map((e, i) => ({ ...e, key: i })).filter((e) => shownIds.has(e.source) && shownIds.has(e.target) && positions.has(e.source) && positions.has(e.target)),
    [edges, shownIds, positions]
  );

  const fit = useCallback(() => {
    if (!shownNodes.length) return setTf({ k: 1, x: 0, y: 0 });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of shownNodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const pad = 70;
    const k = Math.min(2.2, Math.min(W / (x1 - x0 + pad * 2 || 1), H / (y1 - y0 + pad * 2 || 1)));
    setTf({ k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k });
  }, [shownNodes, positions]);

  useEffect(() => { fit(); }, [fit]);

  const zoomBy = useCallback((factor, cx = W / 2, cy = H / 2) => {
    setTf((t) => {
      const k = Math.max(0.3, Math.min(5, t.k * factor));
      const r = k / t.k;
      return { k, x: cx - (cx - t.x) * r, y: cy - (cy - t.y) * r };
    });
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || compact) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = ((e.clientX - rect.left) / rect.width) * W;
      const cy = ((e.clientY - rect.top) / rect.height) * H;
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, cx, cy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [compact, zoomBy]);

  const down = (e) => {
    if (compact) return;
    if (e.target.closest?.(".graph-node")) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - d.x) / rect.width) * W, dy = ((e.clientY - d.y) / rect.height) * H;
    if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
    d.x = e.clientX; d.y = e.clientY;
    setTf((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
  };
  const up = () => { drag.current = null; };

  const connected = useMemo(() => {
    if (!selectedId) return null;
    const s = new Set([selectedId]);
    shownEdges.forEach((e) => { if (e.source === selectedId) s.add(e.target); if (e.target === selectedId) s.add(e.source); });
    return s;
  }, [selectedId, shownEdges]);

  if (!nodes.length) return null;

  return (
    <div className="graph-wrap" style={{ height }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className={compact ? "graph-svg compact" : "graph-svg"}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        onClick={() => { if (!compact && !drag.current?.moved) onSelect?.(null); }}
        role="img"
        aria-label="Knowledge graph"
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#94a3b8" />
          </marker>
          <marker id="arrow-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#1e3a8a" />
          </marker>
        </defs>
        <g transform={`translate(${tf.x} ${tf.y}) scale(${tf.k})`}>
          {shownEdges.map((e) => {
            const a = positions.get(e.source), b = positions.get(e.target);
            const hi = selectedId && (e.source === selectedId || e.target === selectedId);
            const dim = selectedId && !hi;
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
            const rr = 9;
            const x2 = b.x - (dx / len) * rr, y2 = b.y - (dy / len) * rr;
            const evidenced = e.document_id != null && e.page_number != null;
            return (
              <g key={e.key} opacity={dim ? 0.12 : 1}>
                <line
                  x1={a.x} y1={a.y} x2={x2} y2={y2}
                  stroke={hi ? "#1e3a8a" : "#94a3b8"}
                  strokeWidth={(hi ? 1.8 : 1) / Math.sqrt(tf.k)}
                  strokeDasharray={evidenced ? undefined : "4 3"}
                  markerEnd={`url(#${hi ? "arrow-hi" : "arrow"})`}
                />
                {hi && !compact && (
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} className="edge-label" fontSize={10 / Math.sqrt(tf.k)} textAnchor="middle">
                    {relText(e.relation)}
                  </text>
                )}
              </g>
            );
          })}
          {shownNodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const sel = n.id === selectedId;
            const dim = connected && !connected.has(n.id);
            const showLabel = !compact && (sel || (connected && connected.has(n.id)) || tf.k > 0.9 || shownNodes.length < 40);
            return (
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.2 : 1}
                className={compact ? "" : "graph-node"}
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => { ev.stopPropagation(); if (!compact) onSelect?.(n.id); }}
                tabIndex={compact ? -1 : 0}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect?.(n.id); } }}
                role={compact ? undefined : "button"}
                aria-label={`${typeLabel(n.type)}: ${n.label}`}
              >
                {sel && <circle r={15} fill="none" stroke={typeColor(n.type)} strokeWidth={2} opacity={0.35} />}
                <circle r={compact ? 7 : 9} fill={typeColor(n.type)} stroke="#fff" strokeWidth={2} />
                {showLabel && (
                  <text y={22} textAnchor="middle" className="node-label" fontSize={compact ? 13 : 11 / Math.sqrt(Math.max(tf.k, 0.6))}>
                    {String(n.label).length > 26 ? String(n.label).slice(0, 25) + "…" : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {!compact && (
        <div className="graph-controls">
          <button onClick={() => zoomBy(1.3)} aria-label="Zoom in" title="Zoom in"><ZoomIn size={16} /></button>
          <button onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out" title="Zoom out"><ZoomOut size={16} /></button>
          <button onClick={fit} aria-label="Fit to screen" title="Fit to screen"><Maximize2 size={16} /></button>
          <button onClick={() => { setTf({ k: 1, x: 0, y: 0 }); onSelect?.(null); }} aria-label="Reset view" title="Reset view"><RotateCcw size={16} /></button>
        </div>
      )}
    </div>
  );
}