import os
import re
import json
import hashlib
import sqlite3
from pathlib import Path
from typing import Optional

import fitz
import networkx as nx

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# ---------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "institq.db"
UPLOAD_DIR = BASE_DIR / "uploads"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_FILE_SIZE = 15 * 1024 * 1024
MAX_PAGES = 300

app = FastAPI(
    title="INSTITIQ API",
    description="Institutional Knowledge Discovery and Graph Engine",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

graph = nx.MultiDiGraph()


# ---------------------------------------------------------
# DATABASE
# ---------------------------------------------------------

def db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def table_columns(conn, table):
    return {
        row["name"]
        for row in conn.execute(f"PRAGMA table_info({table})")
    }


def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                file_path TEXT NOT NULL,
                content_hash TEXT UNIQUE,
                pages INTEGER DEFAULT 0,
                extracted_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processing_status TEXT DEFAULT 'processed'
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS graph_nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                label TEXT NOT NULL,
                description TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS graph_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                relation TEXT NOT NULL,
                document_id TEXT,
                page_number INTEGER,
                is_outdated INTEGER DEFAULT 0,
                outdated_reason TEXT DEFAULT ''
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS review_flags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                reason TEXT NOT NULL,
                document_id TEXT,
                page_number INTEGER,
                status TEXT DEFAULT 'Needs Review',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS document_nodes (
                document_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                PRIMARY KEY (document_id, node_id)
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS document_node_sources (
                document_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                PRIMARY KEY (document_id, node_id, page_number)
            )
        """)

        def ensure_column(table, column, definition):
            columns = table_columns(conn, table)
            if column not in columns:
                conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
                )

        ensure_column("documents", "file_path", "TEXT")
        ensure_column("documents", "extracted_count", "INTEGER DEFAULT 0")
        ensure_column("documents", "created_at", "TIMESTAMP")
        ensure_column("documents", "processing_status", "TEXT DEFAULT 'processed'")
        ensure_column("graph_nodes", "type", "TEXT")
        ensure_column("graph_edges", "page_number", "INTEGER")
        ensure_column("graph_edges", "is_outdated", "INTEGER DEFAULT 0")
        ensure_column("graph_edges", "outdated_reason", "TEXT DEFAULT ''")
        ensure_column("review_flags", "page_number", "INTEGER")

        # Safe update checks for existing legacy databases
        doc_cols = table_columns(conn, "documents")
        if "uploaded_at" in doc_cols:
            conn.execute("""
                UPDATE documents
                SET created_at = uploaded_at
                WHERE created_at IS NULL AND uploaded_at IS NOT NULL
            """)

        node_cols = table_columns(conn, "graph_nodes")
        if "kind" in node_cols:
            conn.execute("""
                UPDATE graph_nodes
                SET type = kind
                WHERE type IS NULL AND kind IS NOT NULL
            """)

        edge_cols = table_columns(conn, "graph_edges")
        if "page" in edge_cols:
            conn.execute("""
                UPDATE graph_edges
                SET page_number = page
                WHERE page_number IS NULL AND page IS NOT NULL
            """)

        flag_cols = table_columns(conn, "review_flags")
        if "page" in flag_cols:
            conn.execute("""
                UPDATE review_flags
                SET page_number = page
                WHERE page_number IS NULL AND page IS NOT NULL
            """)

        conn.execute("""
            UPDATE documents
            SET processing_status = 'processed'
            WHERE processing_status IS NULL
        """)

        conn.execute("""
            INSERT OR IGNORE INTO document_nodes (document_id, node_id)
            SELECT document_id, source
            FROM graph_edges
            WHERE document_id IS NOT NULL
        """)

        conn.execute("""
            INSERT OR IGNORE INTO document_nodes (document_id, node_id)
            SELECT document_id, target
            FROM graph_edges
            WHERE document_id IS NOT NULL
        """)


def load_graph():
    graph.clear()

    with db() as conn:
        nodes = conn.execute(
            "SELECT * FROM graph_nodes"
        ).fetchall()

        edges = conn.execute(
            "SELECT * FROM graph_edges"
        ).fetchall()

    for node in nodes:
        graph.add_node(
            node["id"],
            type=node["type"],
            label=node["label"],
            description=node["description"]
        )

    for edge in edges:
        if edge["source"] in graph and edge["target"] in graph:
            graph.add_edge(
                edge["source"],
                edge["target"],
                id=edge["id"],
                relation=edge["relation"],
                document_id=edge["document_id"],
                page_number=edge["page_number"]
            )


@app.on_event("startup")
def startup():
    init_db()
    load_graph()


# ---------------------------------------------------------
# GRAPH HELPERS
# ---------------------------------------------------------

def make_id(kind: str, label: str):
    value = f"{kind}:{label.lower().strip()}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def add_node(
    kind: str,
    label: str,
    description: str = "",
    document_id: Optional[str] = None,
    page_number: Optional[int] = None
):
    label = re.sub(r"\s+", " ", label).strip()

    if not label:
        return None

    node_id = make_id(kind, label)

    with db() as conn:
        columns = table_columns(conn, "graph_nodes")
        if "kind" in columns:
            conn.execute("""
                INSERT OR IGNORE INTO graph_nodes
                (id, type, kind, label, description)
                VALUES (?, ?, ?, ?, ?)
            """, (node_id, kind, kind, label, description))
        else:
            conn.execute("""
                INSERT OR IGNORE INTO graph_nodes
                (id, type, label, description)
                VALUES (?, ?, ?, ?)
            """, (node_id, kind, label, description))
        if document_id:
            conn.execute("""
                INSERT OR IGNORE INTO document_nodes (document_id, node_id)
                VALUES (?, ?)
            """, (document_id, node_id))
            if page_number is not None:
                conn.execute("""
                    INSERT OR IGNORE INTO document_node_sources
                    (document_id, node_id, page_number)
                    VALUES (?, ?, ?)
                """, (document_id, node_id, page_number))

    graph.add_node(
        node_id,
        type=kind,
        label=label,
        description=description
    )

    return node_id


def add_edge(
    source: str,
    target: str,
    relation: str,
    document_id: str,
    page: int
):
    if source == target:
        return

    with db() as conn:
        exists = conn.execute("""
            SELECT id FROM graph_edges
            WHERE source = ?
            AND target = ?
            AND relation = ?
            AND document_id = ?
            AND page_number = ?
        """, (
            source, target, relation, document_id, page
        )).fetchone()

        if exists:
            return

        columns = table_columns(conn, "graph_edges")
        if "page" in columns:
            conn.execute("""
                INSERT INTO graph_edges
                (source, target, relation, document_id, page, page_number)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                source, target, relation, document_id, page, page
            ))
        else:
            conn.execute("""
                INSERT INTO graph_edges
                (source, target, relation, document_id, page_number)
                VALUES (?, ?, ?, ?, ?)
            """, (
                source, target, relation, document_id, page
            ))

    graph.add_edge(
        source,
        target,
        relation=relation,
        document_id=document_id,
        page_number=page
    )


def add_flag(
    title: str,
    reason: str,
    document_id: Optional[str] = None,
    page: Optional[int] = None
):
    with db() as conn:
        exists = conn.execute("""
            SELECT id FROM review_flags
            WHERE title = ?
            AND document_id = ?
            AND page_number = ?
            AND status = 'Needs Review'
        """, (title, document_id, page)).fetchone()

        if exists:
            return

        columns = table_columns(conn, "review_flags")
        if "page" in columns:
            conn.execute("""
                INSERT INTO review_flags
                (title, reason, document_id, page, page_number, created_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, (title, reason, document_id, page, page))
        else:
            conn.execute("""
                INSERT INTO review_flags
                (title, reason, document_id, page_number, created_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, (title, reason, document_id, page))


# ---------------------------------------------------------
# ENTITY EXTRACTION
# ---------------------------------------------------------

def extract_entities(text: str):
    """
    Rule-assisted extraction tuned for institutional regulations.
    """
    entities = []
    seen = set()

    def add(kind, label):
        label = re.sub(r"\s+", " ", label).strip(" \t\r\n:;.-")
        if not 3 <= len(label) <= 180:
            return
        key = (kind, label.lower())
        if key not in seen:
            seen.add(key)
            entities.append((kind, label))

    # Structured headings patterns
    patterns = {
        "process": [
            r"(?im)^\s*(?:process|procedure|application process|steps to|procedure for)\s*[:\-–]?\s*(.{3,180})$",
            r"(?im)^\s*how to apply for\s+(.{3,150})$",
        ],
        "department": [
            r"(?im)^\s*(?:department|office|section|authority|academic office)\s*[:\-–]\s*(.{3,150})$",
        ],
        "form": [
            r"(?im)^\s*(?:form|application form)\s*[:\-–]\s*(.{3,150})$",
        ],
        "document": [
            r"(?im)^\s*(?:required documents|documents required|document)\s*[:\-–]\s*(.{3,150})$",
        ],
        "policy": [
            r"(?im)^\s*(?:policy|regulation|guideline|rules?)\s*[:\-–]\s*(.{3,150})$",
        ],
    }

    for kind, expressions in patterns.items():
        for pattern in expressions:
            for match in re.findall(pattern, text):
                add(kind, match)

    # Core institutional processes
    academic_processes = {
        "Course Registration": r"\bcourse registration\b",
        "Course Withdrawal": r"\bcourse withdrawal\b",
        "Course Add or Drop": r"\b(?:add|drop)\s+(?:a\s+)?courses?\b",
        "Attendance Requirements": r"\battendance requirements?\b",
        "Examination Procedure": r"\b(?:examination|exam)\s+(?:rules?|procedure|regulations?)\b",
        "Grade Appeal": r"\b(?:grade|result)\s+appeal\b",
        "Academic Probation": r"\bacademic probation\b",
        "Semester Registration": r"\bsemester registration\b",
        "Fee Payment": r"\b(?:tuition|semester|academic)\s+fee payment\b",
        "Degree Requirements": r"\bdegree requirements?\b",
        "Leave of Absence": r"\bleave of absence\b",
        "Student Grievance": r"\bstudent grievances?\b",
        "Branch Change": r"\bbranch change\b",
        "Make-up Examination": r"\bmake-?up examination\b",
        "Self-study Course": r"\bself-study course\b",
        "Independent Study": r"\bindependent study\b",
        "Dual Degree Conversion": r"\bdual-?degree\b",
        "Ph.D. Candidacy Qualifier": r"\bqualifier requirements?\b|\bcandidacy\b",
        "Thesis Submission": r"\bthesis submission\b|\bsynopsis\b",
        "Student Exchange Program": r"\bstudent exchange\b",
        "Registration Kept Alive": r"\bregistration kept alive\b|\brka\b",
    }

    for label, pattern in academic_processes.items():
        if re.search(pattern, text, re.IGNORECASE):
            add("process", label)

    # Institutional offices and authorities
    authority_patterns = {
        "Dean (Academics)": r"\bdean\s*\((?:academics|ug|pg)\)\b|\bdean\s+academics\b",
        "DUGC (Department UG Committee)": r"\bdugc\b|\bdepartment undergraduate committee\b",
        "DRC (Department Research Committee)": r"\bdrc\b|\bdepartmental research committee\b",
        "Senate / Chairman Senate": r"\bsenate\b|\bchairman,?\s*senate\b",
        "Course Coordinator / Instructor": r"\bcourse coordinator\b|\binstructor\b",
        "Office of Academics": r"\boffice of academics\b",
        "Office of Students": r"\boffice of students\b",
        "Student Research Committee (SRC)": r"\bstudent research committee\b|\bsrc\b",
    }

    for label, pattern in authority_patterns.items():
        if re.search(pattern, text, re.IGNORECASE):
            add("department", label)

    # Policies and regulations
    policy_patterns = [
        r"\bacademic regulations?\b",
        r"\bexamination regulations?\b",
        r"\battendance policy\b",
        r"\bgrading policy\b",
        r"\bcode of conduct\b",
        r"\breservation policy\b",
        r"\bleave rules\b",
    ]

    for pattern in policy_patterns:
        for match in re.findall(pattern, text, re.IGNORECASE):
            add("policy", match)

    # Documents and forms
    document_patterns = [
        r"\bidentity proof\b",
        r"\bmedical certificate\b",
        r"\btranscript\b",
        r"\bregistration form\b",
        r"\bapplication form\b",
        r"\bno objection certificate\b|\bnoc\b",
        r"\bprovisional certificate\b",
        r"\bno dues clearance\b",
        r"\bgrade card\b",
    ]

    for pattern in document_patterns:
        for match in re.findall(pattern, text, re.IGNORECASE):
            add("document", match)

    return entities


# ---------------------------------------------------------
# PAGE PROCESSING
# ---------------------------------------------------------

def process_page(text: str, document_id: str, page_number: int):
    entities = extract_entities(text)
    ids = []

    for kind, label in entities:
        node_id = add_node(
            kind,
            label,
            "Candidate extracted from uploaded source",
            document_id,
            page_number
        )

        if node_id:
            ids.append((kind, node_id))

    relations = {
        ("process", "department"): "handled_by",
        ("process", "form"): "requires_form",
        ("process", "document"): "requires_document",
        ("process", "policy"): "governed_by",
        ("department", "process"): "responsible_for",
    }

    for kind, node_id in ids:
        for other_kind, other_id in ids:
            if node_id == other_id:
                continue

            relation = relations.get((kind, other_kind))

            if relation:
                add_edge(
                    node_id,
                    other_id,
                    relation,
                    document_id,
                    page_number
                )

    # Outdated / Deprecated detection based on amendments or circular wording
    legacy_or_outdated = re.search(
        r"(?i)\b(?:outdated|deprecated|superseded|amended|replaced by|prior to 201\d|no longer applicable)\b",
        text
    )
    if legacy_or_outdated:
        add_flag(
            "Outdated Connection / Policy Flag",
            f"Page mentions potential deprecated or amended clauses ({legacy_or_outdated.group(0)}). Review dependencies and connections manually.",
            document_id,
            page_number
        )

    # Unstructured process text discovery review check
    process_terms = [
        ("Course registration reference", r"course\s+registration|registration\s+(?:of|for)\s+courses?"),
        ("Course withdrawal reference", r"course\s+withdrawal|withdrawal\s+from\s+courses?"),
        ("Examination reference", r"examination|\bexam\b"),
        ("Application reference", r"application\s+(?:for|to)|apply\s+for"),
        ("Appeal reference", r"appeal|grievance"),
        ("Procedure reference", r"procedure|process|steps\s+to"),
        ("Submission reference", r"submit|submission|last\s+date"),
        ("Academic regulation reference", r"academic\s+regulation|regulations?|policy|ordinance"),
    ]
    structured_process_kinds = {"process", "department", "form", "policy"}
    has_structured_process = any(kind.lower() in structured_process_kinds for kind, _ in entities)

    if not has_structured_process:
        normalized_text = re.sub(r"[ \t]+", " ", text)
        sentences = [
            re.sub(r"\s+", " ", part).strip()
            for part in re.split(r"(?<=[.!?])\s+|\n+", normalized_text)
            if part.strip()
        ]
        matched_labels = set()
        for label, pattern in process_terms:
            if label in matched_labels or not re.search(pattern, normalized_text, re.IGNORECASE):
                continue
            matched_labels.add(label)
            evidence = next(
                (sentence for sentence in sentences
                 if re.search(pattern, sentence, re.IGNORECASE)),
                ""
            )[:420].strip()
            reason = (
                f"The source page contains wording related to {label.lower()}, "
                "but no structured process, office, form, or policy entity "
                "was extracted. Treat this as a candidate for human review, "
                "not a confirmed institutional requirement."
            )
            if evidence:
                reason += f'\n\nSource excerpt: “{evidence}”'
            add_flag(label, reason, document_id, page_number)

    return len(entities)


# ---------------------------------------------------------
# REQUEST MODELS
# ---------------------------------------------------------

class SearchRequest(BaseModel):
    query: str
    category: Optional[str] = None


class ReviewUpdate(BaseModel):
    status: str


# ---------------------------------------------------------
# ROOT AND HEALTH
# ---------------------------------------------------------

@app.get("/")
def root():
    return {
        "service": "INSTITIQ",
        "description": "Institutional Knowledge Discovery",
        "version": "2.0.0",
        "status": "running"
    }


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "INSTITIQ",
        "version": "2.0.0"
    }


# ---------------------------------------------------------
# PDF UPLOAD
# ---------------------------------------------------------

@app.post("/api/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    filename = file.filename or "document.pdf"

    if not filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are supported."
        )

    content = await file.read()

    if not content:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is empty."
        )

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail="File exceeds the 15 MB limit."
        )

    content_hash = hashlib.sha256(content).hexdigest()

    with db() as conn:
        existing = conn.execute("""
            SELECT id, filename FROM documents
            WHERE content_hash = ?
        """, (content_hash,)).fetchone()

    if existing:
        return {
            "message": "This document has already been uploaded.",
            "document_id": existing["id"],
            "filename": existing["filename"],
            "duplicate": True
        }

    try:
        pdf = fitz.open(stream=content, filetype="pdf")
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Unable to read this PDF."
        )

    if len(pdf) > MAX_PAGES:
        pdf.close()
        raise HTTPException(
            status_code=400,
            detail="PDF exceeds the 300-page limit."
        )

    document_id = hashlib.sha256(
        (content_hash + filename).encode()
    ).hexdigest()[:16]

    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", filename)
    file_path = UPLOAD_DIR / f"{document_id}_{safe_name}"

    file_path.write_bytes(content)

    total_entities = 0
    extracted_pages = 0
    page_count = len(pdf)

    try:
        for index, page in enumerate(pdf):
            page_text = page.get_text("text")

            if page_text.strip():
                count = process_page(
                    page_text,
                    document_id,
                    index + 1
                )

                total_entities += count

                if count:
                    extracted_pages += 1

    finally:
        pdf.close()

    with db() as conn:
        conn.execute("""
            INSERT INTO documents
            (id, filename, file_path, content_hash, pages, extracted_count, processing_status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            document_id,
            filename,
            str(file_path),
            content_hash,
            page_count,
            total_entities,
            "processed"
        ))

    return {
        "message": "Document uploaded and processed successfully.",
        "document_id": document_id,
        "filename": filename,
        "pages": page_count,
        "extracted_entities": total_entities,
        "pages_with_entities": extracted_pages,
        "duplicate": False
    }


# ---------------------------------------------------------
# DOCUMENTS
# ---------------------------------------------------------

@app.get("/api/documents")
def get_documents():
    with db() as conn:
        rows = conn.execute("""
            SELECT id, filename, pages, extracted_count, processing_status, created_at
            FROM documents
            ORDER BY created_at DESC
        """).fetchall()

    return [dict(row) for row in rows]


def find_document_pdf(document):
    stored_path = document["file_path"]
    if stored_path:
        path = Path(stored_path)
        if not path.is_absolute():
            path = BASE_DIR / path
        if path.is_file():
            return path

    safe_name = re.sub(
        r"[^a-zA-Z0-9._-]",
        "_",
        document["filename"]
    )
    expected_path = UPLOAD_DIR / f"{document['id']}_{safe_name}"
    if expected_path.is_file():
        return expected_path

    matches = list(UPLOAD_DIR.glob(f"{document['id']}_*.pdf"))
    if matches:
        return matches[0]

    return None


def remove_document_data(document_id: str):
    with db() as conn:
        node_ids = [
            row["node_id"]
            for row in conn.execute(
                "SELECT node_id FROM document_nodes WHERE document_id = ?",
                (document_id,)
            ).fetchall()
        ]

        conn.execute(
            "DELETE FROM graph_edges WHERE document_id = ?",
            (document_id,)
        )
        conn.execute(
            "DELETE FROM review_flags WHERE document_id = ?",
            (document_id,)
        )
        conn.execute(
            "DELETE FROM document_nodes WHERE document_id = ?",
            (document_id,)
        )
        conn.execute(
            "DELETE FROM document_node_sources WHERE document_id = ?",
            (document_id,)
        )

        for node_id in node_ids:
            still_used = conn.execute("""
                SELECT 1
                FROM document_nodes
                WHERE node_id = ?
                LIMIT 1
            """, (node_id,)).fetchone()
            has_edges = conn.execute("""
                SELECT 1
                FROM graph_edges
                WHERE source = ? OR target = ?
                LIMIT 1
            """, (node_id, node_id)).fetchone()
            if not still_used and not has_edges:
                conn.execute(
                    "DELETE FROM graph_nodes WHERE id = ?",
                    (node_id,)
                )


@app.post("/api/documents/{document_id}/reprocess")
def reprocess_document(document_id: str):
    with db() as conn:
        document = conn.execute(
            "SELECT * FROM documents WHERE id = ?",
            (document_id,)
        ).fetchone()

    if not document:
        raise HTTPException(
            status_code=404,
            detail=f"Document '{document_id}' was not found."
        )

    pdf_path = find_document_pdf(document)
    if not pdf_path:
        raise HTTPException(
            status_code=404,
            detail="The stored PDF file for this document could not be found."
        )

    try:
        pdf = fitz.open(pdf_path)
    except (fitz.FileDataError, OSError) as exc:
        raise HTTPException(
            status_code=422,
            detail="The stored PDF could not be opened for reprocessing."
        ) from exc

    page_count = len(pdf)
    if page_count > MAX_PAGES:
        pdf.close()
        raise HTTPException(
            status_code=422,
            detail="The stored PDF exceeds the 300-page limit."
        )

    with db() as conn:
        conn.execute("""
            UPDATE documents
            SET processing_status = ?
            WHERE id = ?
        """, ("processing", document_id))

    try:
        remove_document_data(document_id)
        load_graph()

        extracted_count = 0
        for index, page in enumerate(pdf):
            page_text = page.get_text("text")
            if page_text.strip():
                extracted_count += process_page(
                    page_text,
                    document_id,
                    index + 1
                )

        pdf.close()

        with db() as conn:
            conn.execute("""
                UPDATE documents
                SET file_path = ?,
                    pages = ?,
                    extracted_count = ?,
                    processing_status = ?
                WHERE id = ?
            """, (
                str(pdf_path),
                page_count,
                extracted_count,
                "processed",
                document_id
            ))
            review_flag_count = conn.execute("""
                SELECT COUNT(*)
                FROM review_flags
                WHERE document_id = ?
            """, (document_id,)).fetchone()[0]

        load_graph()

        return {
            "message": "Document reprocessed successfully.",
            "document_id": document_id,
            "pages": page_count,
            "extracted_entities": extracted_count,
            "review_flags": review_flag_count,
            "processing_status": "processed"
        }
    except Exception as exc:
        pdf.close()
        with db() as conn:
            conn.execute("""
                UPDATE documents
                SET processing_status = ?
                WHERE id = ?
            """, ("failed", document_id))
        load_graph()
        raise HTTPException(
            status_code=500,
            detail="Document reprocessing failed."
        ) from exc


# ---------------------------------------------------------
# KNOWLEDGE GRAPH
# ---------------------------------------------------------

@app.get("/api/graph")
def get_graph():
    nodes = [
        {
            "id": node_id,
            **data
        }
        for node_id, data in graph.nodes(data=True)
    ]

    edges = []

    for source, target, data in graph.edges(data=True):
        edges.append({
            "source": source,
            "target": target,
            **data
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "total_nodes": len(nodes),
        "total_edges": len(edges)
    }


@app.get("/api/graph/nodes/{node_id}")
def get_graph_node(node_id: str):
    node = graph.nodes.get(node_id)
    if node is None:
        raise HTTPException(
            status_code=404,
            detail=f"Graph node '{node_id}' was not found."
        )

    with db() as conn:
        sources = conn.execute("""
            SELECT DISTINCT
                d.id AS document_id,
                d.filename,
                s.page_number
            FROM document_node_sources s
            JOIN documents d ON d.id = s.document_id
            WHERE s.node_id = ?
            ORDER BY d.filename, s.page_number
        """, (node_id,)).fetchall()

    return {
        "id": node_id,
        **node,
        "sources": [dict(source) for source in sources]
    }


# ---------------------------------------------------------
# KNOWLEDGE SEARCH
# ---------------------------------------------------------

@app.post("/api/search")
def search_knowledge(request: SearchRequest):
    query = request.query.strip().lower()

    if not query:
        return {
            "matches": [],
            "total": 0
        }

    matches = []

    for node_id, data in graph.nodes(data=True):
        label = data.get("label", "")
        description = data.get("description", "")

        if query in label.lower() or query in description.lower():
            outgoing = []

            for _, target, edge_data in graph.out_edges(
                node_id, data=True
            ):
                target_data = graph.nodes[target]

                outgoing.append({
                    "id": target,
                    "label": target_data.get("label", ""),
                    "type": target_data.get("type", ""),
                    "relation": edge_data.get("relation", "")
                })

            incoming = []

            for source, _, edge_data in graph.in_edges(
                node_id, data=True
            ):
                source_data = graph.nodes[source]

                incoming.append({
                    "id": source,
                    "label": source_data.get("label", ""),
                    "type": source_data.get("type", ""),
                    "relation": edge_data.get("relation", "")
                })

            with db() as conn:
                sources = conn.execute("""
                    SELECT DISTINCT
                        d.id AS document_id,
                        d.filename,
                        s.page_number
                    FROM document_node_sources s
                    JOIN documents d ON d.id = s.document_id
                    WHERE s.node_id = ?
                    ORDER BY d.filename, s.page_number
                """, (node_id,)).fetchall()

                edge_sources = conn.execute("""
                    SELECT DISTINCT
                        d.id AS document_id,
                        d.filename,
                        e.page_number
                    FROM graph_edges e
                    JOIN documents d ON d.id = e.document_id
                    WHERE e.source = ? OR e.target = ?
                    ORDER BY d.filename, e.page_number
                """, (node_id, node_id)).fetchall()

            source_values = {
                (source["document_id"], source["filename"], source["page_number"])
                for source in [*sources, *edge_sources]
            }
            source_references = [
                {
                    "document_id": document_id,
                    "filename": filename,
                    "page_number": page_number
                }
                for document_id, filename, page_number
                in sorted(source_values, key=lambda value: (
                    value[1], value[2] is None, value[2] or 0
                ))
            ]

            matches.append({
                "id": node_id,
                "label": label,
                "type": data.get("type", ""),
                "description": description,
                "connections": outgoing + incoming,
                "sources": source_references
            })

    if request.category:
        matches = [
            item for item in matches
            if item["type"].lower() == request.category.lower()
        ]

    return {
        "matches": matches,
        "total": len(matches)
    }


# ---------------------------------------------------------
# INTEGRITY REVIEW
# ---------------------------------------------------------

@app.get("/api/reviews")
def get_reviews():
    with db() as conn:
        rows = conn.execute("""
            SELECT
                r.id,
                r.title,
                r.reason,
                r.document_id,
                r.page_number,
                r.status,
                r.created_at,
                d.filename
            FROM review_flags r
            LEFT JOIN documents d ON d.id = r.document_id
            ORDER BY r.created_at DESC
        """).fetchall()

    return [dict(row) for row in rows]


@app.patch("/api/reviews/{review_id}")
def update_review(review_id: int, update: ReviewUpdate):
    allowed = ["Verified", "Dismissed", "Needs Review"]

    if update.status not in allowed:
        raise HTTPException(
            status_code=400,
            detail="Invalid review status."
        )

    with db() as conn:
        result = conn.execute("""
            UPDATE review_flags
            SET status = ?
            WHERE id = ?
        """, (update.status, review_id))

        if result.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="Review item not found."
            )

    return {
        "message": "Review status updated.",
        "id": review_id,
        "status": update.status
    }


# ---------------------------------------------------------
# DASHBOARD
# ---------------------------------------------------------

@app.get("/api/dashboard")
def get_dashboard():
    with db() as conn:
        document_count = conn.execute(
            "SELECT COUNT(*) FROM documents"
        ).fetchone()[0]

        node_count = conn.execute(
            "SELECT COUNT(*) FROM graph_nodes"
        ).fetchone()[0]

        edge_count = conn.execute(
            "SELECT COUNT(*) FROM graph_edges"
        ).fetchone()[0]

        pending_count = conn.execute("""
            SELECT COUNT(*) FROM review_flags
            WHERE status = 'Needs Review'
        """).fetchone()[0]

        recent_documents = conn.execute("""
            SELECT id, filename, pages, extracted_count, created_at
            FROM documents
            ORDER BY created_at DESC
            LIMIT 5
        """).fetchall()

    return {
        "total_documents": document_count,
        "total_nodes": node_count,
        "total_edges": edge_count,
        "pending_reviews": pending_count,
        "documents": document_count,
        "nodes": node_count,
        "edges": edge_count,
        "reviews": pending_count,
        "recent_documents": [
            dict(row) for row in recent_documents
        ]
    }