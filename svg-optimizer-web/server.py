from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import threading
import time
import urllib.parse
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from optimizer import analyze_svg, optimize_svg

APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"
WORK_DIR = Path(os.environ.get("WORK_DIR", "/tmp/daxart-svg-optimizer"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "200"))
MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024
SESSION_TTL = int(os.environ.get("SESSION_TTL_SECONDS", "7200"))

sessions: dict[str, dict] = {}
jobs: dict[str, dict] = {}
lock = threading.RLock()


def safe_name(name: str) -> str:
    name = Path(name or "input.svg").name
    clean = "".join(c for c in name if c.isalnum() or c in " ._#()-[]")
    return clean[:180] or "input.svg"


def json_bytes(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")


def sanitize_json(obj):
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_json(v) for v in obj]
    return obj


class Handler(BaseHTTPRequestHandler):
    server_version = "DaxARTSVGOptimizer/3.0"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, obj, status=200):
        data = json_bytes(sanitize_json(obj))
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path, content_type=None, download_name=None):
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        ctype = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        st = path.stat()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(st.st_size))
        self.send_header("Cache-Control", "no-store")
        if download_name:
            quoted = urllib.parse.quote(download_name)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, length=1024 * 1024)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path = u.path
        q = urllib.parse.parse_qs(u.query)
        if path == "/api/health":
            self.send_json({"ok": True, "version": "4.0.0-web", "maxUploadMB": MAX_UPLOAD_MB})
            return
        if path == "/api/job":
            jid = q.get("id", [""])[0]
            with lock:
                job = jobs.get(jid)
                payload = dict(job) if job else None
            if not payload:
                self.send_json({"error": "Job non trovato"}, 404)
            else:
                self.send_json(payload)
            return
        if path == "/api/preview":
            token = q.get("token", [""])[0]
            kind = q.get("kind", ["original"])[0]
            with lock:
                sess = sessions.get(token)
                p = Path(sess.get("opt_preview" if kind == "optimized" else "orig_preview", "")) if sess else None
            if not p:
                self.send_error(404)
            else:
                self.send_file(p, "image/svg+xml")
            return
        if path == "/api/download":
            token = q.get("token", [""])[0]
            with lock:
                sess = sessions.get(token)
                p = Path(sess.get("output", "")) if sess and sess.get("output") else None
                name = sess.get("download_name") if sess else None
            if not p:
                self.send_error(404)
            else:
                self.send_file(p, "image/svg+xml", name or "optimized.svg")
            return

        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        try:
            target.relative_to(WEB_DIR.resolve())
        except ValueError:
            self.send_error(403)
            return
        self.send_file(target)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/upload":
            self.handle_upload()
            return
        if u.path == "/api/optimize":
            self.handle_optimize()
            return
        self.send_error(404)

    def handle_upload(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self.send_json({"error": "File vuoto"}, 400)
            return
        if length > MAX_UPLOAD:
            self.send_json({"error": f"File troppo grande: limite {MAX_UPLOAD_MB} MB"}, 413)
            return
        raw_name = urllib.parse.unquote(self.headers.get("X-Filename", "input.svg"))
        filename = safe_name(raw_name)
        if not filename.lower().endswith(".svg"):
            self.send_json({"error": "Seleziona un file .svg"}, 400)
            return
        token = uuid.uuid4().hex
        folder = WORK_DIR / token
        folder.mkdir(parents=True, exist_ok=True)
        source = folder / filename
        remaining = length
        try:
            with open(source, "wb") as f:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise IOError("Upload locale interrotto")
                    f.write(chunk)
                    remaining -= len(chunk)
            orig_preview = folder / "original_preview.svg"
            analysis = analyze_svg(source, orig_preview)
            sess = {
                "token": token,
                "source": str(source),
                "orig_preview": str(orig_preview),
                "analysis": analysis,
                "filename": filename,
                "created": time.time(),
            }
            with lock:
                sessions[token] = sess
            self.send_json({
                "token": token,
                "filename": filename,
                "analysis": analysis,
                "previewUrl": f"/api/preview?token={token}&kind=original&v={time.time_ns()}",
            })
        except Exception as exc:
            shutil.rmtree(folder, ignore_errors=True)
            self.send_json({"error": str(exc)}, 500)

    def handle_optimize(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            req = json.loads(body.decode("utf-8"))
        except Exception:
            self.send_json({"error": "Richiesta non valida"}, 400)
            return
        token = req.get("token", "")
        options = req.get("options", {})
        with lock:
            sess = sessions.get(token)
        if not sess:
            self.send_json({"error": "Sessione non trovata. Ricarica il file."}, 404)
            return
        jid = uuid.uuid4().hex
        with lock:
            jobs[jid] = {"id": jid, "token": token, "state": "queued", "message": "In coda…", "progress": 0.0}
        thread = threading.Thread(target=run_optimize_job, args=(jid, token, options), daemon=True)
        thread.start()
        self.send_json({"jobId": jid})


def run_optimize_job(job_id: str, token: str, options: dict):
    with lock:
        sess = sessions.get(token)
        if not sess:
            jobs[job_id] = {"id": job_id, "state": "error", "message": "Sessione non trovata"}
            return
        source = Path(sess["source"])
        folder = source.parent
        base = source.stem
        output = folder / f"{base}_PLOTTER.svg"
        preview = folder / "optimized_preview.svg"
        jobs[job_id].update({"state": "running", "message": "Avvio…", "progress": 0.01})

    def cb(message: str, fraction: float | None):
        with lock:
            if job_id in jobs:
                jobs[job_id]["message"] = message
                if fraction is not None:
                    jobs[job_id]["progress"] = fraction

    try:
        job_options = dict(options)
        job_options['_expectedPaths'] = sess.get('analysis', {}).get('stats', {}).get('paths', 0)
        result = optimize_svg(source, output, preview, job_options, cb)
        download_name = f"{base}_PLOTTER.svg"
        with lock:
            sess = sessions[token]
            sess["output"] = str(output)
            sess["opt_preview"] = str(preview)
            sess["download_name"] = download_name
            jobs[job_id] = {
                "id": job_id,
                "token": token,
                "state": "done",
                "message": "Completato",
                "progress": 1.0,
                "result": result,
                "previewUrl": f"/api/preview?token={token}&kind=optimized&v={time.time_ns()}",
                "downloadUrl": f"/api/download?token={token}",
            }
    except Exception as exc:
        with lock:
            jobs[job_id] = {"id": job_id, "token": token, "state": "error", "message": str(exc), "progress": 0.0}


def cleanup_workdir(clear_all: bool = False):
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for p in WORK_DIR.iterdir():
        try:
            expired = clear_all or (now - p.stat().st_mtime > SESSION_TTL)
        except OSError:
            expired = True
        if not expired:
            continue
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            try:
                p.unlink()
            except OSError:
                pass


def cleanup_state():
    cutoff = time.time() - SESSION_TTL
    stale_tokens = []
    stale_jobs = []
    with lock:
        for token, sess in sessions.items():
            if sess.get("created", 0) < cutoff:
                stale_tokens.append(token)
        for jid, job in jobs.items():
            token = job.get("token")
            if token in stale_tokens:
                stale_jobs.append(jid)
        for jid in stale_jobs:
            jobs.pop(jid, None)
        for token in stale_tokens:
            sessions.pop(token, None)
    cleanup_workdir(False)


def janitor_loop():
    while True:
        time.sleep(600)
        try:
            cleanup_state()
        except Exception as exc:
            print(f"[janitor] {exc}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="DaxART SVG Plotter Optimizer Web")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    cleanup_workdir(clear_all=True)
    threading.Thread(target=janitor_loop, daemon=True).start()

    port = args.port or int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer((args.host, port), Handler)
    print("DaxART SVG Plotter Optimizer Web", flush=True)
    print(f"Listening on http://{args.host}:{port}", flush=True)
    print(f"Upload limit: {MAX_UPLOAD_MB} MB · session TTL: {SESSION_TTL}s", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Chiusura…", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()