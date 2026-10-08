from __future__ import annotations

import html
import math
import os
import re
import shutil
import xml.parsers.expat
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, Iterable, Optional

MM_PER_UNIT = {
    "mm": 1.0,
    "cm": 10.0,
    "in": 25.4,
    "pt": 25.4 / 72.0,
    "pc": 25.4 / 6.0,
    "px": 25.4 / 96.0,
    "q": 0.25,
}

TAG_RE = re.compile(r"<\s*(/?)\s*([a-zA-Z][\w:.-]*)([^>]*?)(/?)\s*>", re.S)
ATTR_RE = re.compile(r"([:\w.-]+)\s*=\s*(\"([^\"]*)\"|'([^']*)')", re.S)
TOKEN_RE = re.compile(r"[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
UNSUPPORTED_PATH_RE = re.compile(r"[CcSsQqTtAa]")

ProgressFn = Optional[Callable[[str, float | None], None]]


def _progress(cb: ProgressFn, message: str, fraction: float | None = None) -> None:
    if cb:
        cb(message, fraction)


def detect_encoding(path: str | Path) -> str:
    with open(path, "rb") as f:
        head = f.read(512)
    if head.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if head.startswith(b"\xff\xfe"):
        return "utf-16-le"
    if head.startswith(b"\xfe\xff"):
        return "utf-16-be"
    m = re.search(br"encoding\s*=\s*['\"]([^'\"]+)['\"]", head, re.I)
    if m:
        try:
            return m.group(1).decode("ascii", "ignore") or "utf-8"
        except Exception:
            pass
    return "utf-8"


def read_svg_text(path: str | Path) -> tuple[str, str]:
    enc = detect_encoding(path)
    data = Path(path).read_bytes()
    try:
        return data.decode(enc), enc
    except (UnicodeDecodeError, LookupError):
        try:
            return data.decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            return data.decode("latin-1"), "latin-1"


def parse_attrs(s: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in ATTR_RE.finditer(s):
        out[m.group(1)] = m.group(3) if m.group(3) is not None else m.group(4)
    return out


def attr_value(tag: str, name: str) -> Optional[str]:
    pat = re.compile(r"\b" + re.escape(name) + r"\s*=\s*(\"([^\"]*)\"|'([^']*)')", re.I | re.S)
    m = pat.search(tag)
    if not m:
        return None
    return m.group(2) if m.group(2) is not None else m.group(3)


def replace_attr(tag: str, name: str, value: str) -> str:
    pat = re.compile(r"(\b" + re.escape(name) + r"\s*=\s*)([\"'])([\s\S]*?)\2", re.I)
    m = pat.search(tag)
    if not m:
        return tag
    q = m.group(2)
    escaped = value.replace("&", "&amp;").replace(q, "&quot;" if q == '"' else "&apos;")
    return tag[:m.start()] + m.group(1) + q + escaped + q + tag[m.end():]


def parse_length(v: Optional[str]) -> Optional[tuple[float, str]]:
    if not v:
        return None
    m = re.match(r"^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$", v)
    if not m:
        return None
    return float(m.group(1)), (m.group(2) or "px").lower()


def length_to_mm(length: Optional[tuple[float, str]]) -> float:
    if not length:
        return math.nan
    v, u = length
    return v * MM_PER_UNIT.get(u, MM_PER_UNIT["px"])


def length_to_css_px(length: Optional[tuple[float, str]]) -> float:
    if not length:
        return math.nan
    v, u = length
    if u in ("", "px"):
        return v
    if u == "mm":
        return v * 96.0 / 25.4
    if u == "cm":
        return v * 96.0 / 2.54
    if u == "in":
        return v * 96.0
    if u == "pt":
        return v * 96.0 / 72.0
    if u == "pc":
        return v * 16.0
    if u == "q":
        return v * 96.0 / 101.6
    return math.nan


def parse_viewbox(v: Optional[str]) -> Optional[tuple[float, float, float, float]]:
    if not v:
        return None
    try:
        a = [float(x) for x in re.split(r"[\s,]+", v.strip()) if x]
    except ValueError:
        return None
    if len(a) != 4 or a[2] == 0 or a[3] == 0:
        return None
    return a[0], a[1], a[2], a[3]


@dataclass
class PageInfo:
    width_attr: Optional[str]
    height_attr: Optional[str]
    viewbox_attr: Optional[str]
    preserve_aspect_ratio: Optional[str]
    width_mm: float
    height_mm: float
    vb_x: float
    vb_y: float
    vb_w: float
    vb_h: float
    explicit_viewbox: bool

    def signature(self) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
        return (self.width_attr, self.height_attr, self.viewbox_attr, self.preserve_aspect_ratio)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["viewBox"] = {"x": self.vb_x, "y": self.vb_y, "w": self.vb_w, "h": self.vb_h}
        return d


def get_page_info(text: str) -> PageInfo:
    m = re.search(r"<svg\b([^>]*)>", text, re.I | re.S)
    if not m:
        raise ValueError("Il file non contiene un elemento <svg> valido.")
    attrs = parse_attrs(m.group(1) or "")
    width_attr = attrs.get("width")
    height_attr = attrs.get("height")
    viewbox_attr = attrs.get("viewBox") or attrs.get("viewbox")
    par = attrs.get("preserveAspectRatio") or attrs.get("preserveaspectratio")
    width_len = parse_length(width_attr)
    height_len = parse_length(height_attr)
    width_mm = length_to_mm(width_len)
    height_mm = length_to_mm(height_len)
    vb = parse_viewbox(viewbox_attr)
    explicit = vb is not None
    if vb is None:
        w = length_to_css_px(width_len)
        h = length_to_css_px(height_len)
        if not (w > 0):
            w = 300.0
        if not (h > 0):
            h = 150.0
        vb = (0.0, 0.0, w, h)
    if not (width_mm > 0):
        width_mm = vb[2] * 25.4 / 96.0
    if not (height_mm > 0):
        height_mm = vb[3] * 25.4 / 96.0
    return PageInfo(width_attr, height_attr, viewbox_attr, par, width_mm, height_mm, *vb, explicit)


# SVG affine matrix: [a,b,c,d,e,f], x'=a*x+c*y+e, y'=b*x+d*y+f

def identity_matrix() -> tuple[float, float, float, float, float, float]:
    return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def multiply_matrix(a, b):
    return (
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    )


def apply_matrix(m, p):
    x, y = p
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def invert_matrix(m):
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-15:
        return None
    return (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)


def parse_transform(s: str):
    out = identity_matrix()
    for m in re.finditer(r"([a-zA-Z]+)\s*\(([^)]*)\)", s or ""):
        name = m.group(1).lower()
        try:
            v = [float(x) for x in re.split(r"[\s,]+", m.group(2).strip()) if x]
        except ValueError:
            continue
        t = identity_matrix()
        if name == "matrix" and len(v) >= 6:
            t = tuple(v[:6])
        elif name == "translate":
            t = (1, 0, 0, 1, v[0] if v else 0, v[1] if len(v) > 1 else 0)
        elif name == "scale":
            sx = v[0] if v else 1
            sy = v[1] if len(v) > 1 else sx
            t = (sx, 0, 0, sy, 0, 0)
        elif name == "rotate":
            ang = math.radians(v[0] if v else 0)
            c, sn = math.cos(ang), math.sin(ang)
            r = (c, sn, -sn, c, 0, 0)
            if len(v) >= 3:
                cx, cy = v[1], v[2]
                t = multiply_matrix(multiply_matrix((1, 0, 0, 1, cx, cy), r), (1, 0, 0, 1, -cx, -cy))
            else:
                t = r
        elif name == "skewx" and v:
            t = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == "skewy" and v:
            t = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        out = multiply_matrix(out, t)
    return out


def root_to_mm_matrix(page: PageInfo):
    sx = page.width_mm / page.vb_w
    sy = page.height_mm / page.vb_h
    par = (page.preserve_aspect_ratio or "xMidYMid meet").strip().lower()
    if "none" in par:
        return (sx, 0, 0, sy, -page.vb_x * sx, -page.vb_y * sy)
    meet = "slice" not in par
    sc = min(abs(sx), abs(sy)) if meet else max(abs(sx), abs(sy))
    content_w = page.vb_w * sc
    content_h = page.vb_h * sc
    extra_x = page.width_mm - content_w
    extra_y = page.height_mm - content_h
    ax = 0.5
    ay = 0.5
    if "xmin" in par:
        ax = 0.0
    elif "xmax" in par:
        ax = 1.0
    if "ymin" in par:
        ay = 0.0
    elif "ymax" in par:
        ay = 1.0
    return (sc, 0, 0, sc, -page.vb_x * sc + extra_x * ax, -page.vb_y * sc + extra_y * ay)


def poly_length(points) -> float:
    s = 0.0
    for i in range(1, len(points)):
        dx = points[i][0] - points[i - 1][0]
        dy = points[i][1] - points[i - 1][1]
        s += math.hypot(dx, dy)
    return s


def path_length_mm(points_mm, closed: bool) -> float:
    s = poly_length([(p[0], p[1]) for p in points_mm])
    if closed and len(points_mm) > 2:
        s += math.hypot(points_mm[-1][0] - points_mm[0][0], points_mm[-1][1] - points_mm[0][1])
    return s


def dedupe_records(records, tol: float):
    if len(records) < 2 or tol <= 0:
        return records[:]
    out = [records[0]]
    for p in records[1:]:
        q = out[-1]
        if math.hypot(p[0] - q[0], p[1] - q[1]) > tol:
            out.append(p)
    return out


def _seg_dist2(p, a, b):
    x, y = a[0], a[1]
    dx, dy = b[0] - x, b[1] - y
    if dx or dy:
        t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
        if t > 1:
            x, y = b[0], b[1]
        elif t > 0:
            x += dx * t
            y += dy * t
    dx, dy = p[0] - x, p[1] - y
    return dx * dx + dy * dy


def rdp(records, eps: float):
    if len(records) < 3 or eps <= 0:
        return records[:]
    sq = eps * eps
    keep = bytearray(len(records))
    keep[0] = keep[-1] = 1
    stack = [(0, len(records) - 1)]
    while stack:
        a, b = stack.pop()
        md = sq
        idx = -1
        for i in range(a + 1, b):
            d = _seg_dist2(records[i], records[a], records[b])
            if d > md:
                md = d
                idx = i
        if idx >= 0:
            keep[idx] = 1
            stack.append((a, idx))
            stack.append((idx, b))
    return [records[i] for i in range(len(records)) if keep[i]]


def simplify_records(records, eps: float, closed: bool):
    if len(records) < 4 or eps <= 0:
        return records[:]
    repeated = math.hypot(records[0][0] - records[-1][0], records[0][1] - records[-1][1]) < 1e-12
    ring = records[:-1] if repeated else records
    if (closed or repeated) and len(ring) >= 4:
        # Split the ring at the point farthest from the first point so RDP never
        # sees coincident/near-coincident endpoints and collapses the loop.
        first = ring[0]
        k = max(range(1, len(ring)), key=lambda i: (ring[i][0] - first[0]) ** 2 + (ring[i][1] - first[1]) ** 2)
        p1 = rdp(ring[: k + 1], eps)
        p2 = rdp(ring[k:] + [ring[0]], eps)
        combined = p1 + p2[1:-1]
        if repeated:
            combined.append(combined[0])
        return combined
    return rdp(records, eps)


def walk_linear_path(d: str, on_subpath: Callable[[list[tuple[float, float]], bool], None]) -> bool:
    if UNSUPPORTED_PATH_RE.search(d):
        return False
    it = iter(TOKEN_RE.finditer(d))
    pending = None
    cmd = None
    cx = cy = sx = sy = 0.0
    pts: list[tuple[float, float]] = []
    closed = False

    def next_token():
        nonlocal pending
        if pending is not None:
            t = pending
            pending = None
            return t
        try:
            return next(it).group(0)
        except StopIteration:
            return None

    def flush():
        nonlocal pts, closed
        if pts:
            on_subpath(pts, closed)
        pts = []
        closed = False

    token = next_token()
    while token is not None:
        if len(token) == 1 and token.isalpha():
            cmd = token
            C = cmd.upper()
            if C == "Z":
                closed = True
                cx, cy = sx, sy
                flush()
                cmd = None
                token = next_token()
                continue
            if C not in ("M", "L", "H", "V"):
                return False
            token = next_token()
            continue
        if cmd is None:
            return False
        rel = cmd.islower()
        C = cmd.upper()
        try:
            if C in ("M", "L"):
                x0 = float(token)
                t2 = next_token()
                if t2 is None or (len(t2) == 1 and t2.isalpha()):
                    return False
                y0 = float(t2)
                x, y = x0, y0
                if rel:
                    x += cx
                    y += cy
                if C == "M":
                    flush()
                    cx, cy = x, y
                    sx, sy = x, y
                    pts = [(x, y)]
                    cmd = "l" if rel else "L"
                else:
                    cx, cy = x, y
                    pts.append((x, y))
                token = next_token()
            elif C == "H":
                x = float(token) + (cx if rel else 0.0)
                cx = x
                pts.append((cx, cy))
                token = next_token()
            elif C == "V":
                y = float(token) + (cy if rel else 0.0)
                cy = y
                pts.append((cx, cy))
                token = next_token()
        except ValueError:
            return False
    flush()
    return True


def parse_points_attr(s: Optional[str]):
    if not s:
        return []
    try:
        nums = [float(x) for x in re.split(r"[\s,]+", s.strip()) if x]
    except ValueError:
        return []
    return [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]


def format_num(v: float, precision: int) -> str:
    s = f"{v:.{precision}f}"
    if precision:
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def serialize_subpath(points, closed: bool, precision: int) -> str:
    if not points:
        return ""
    out = ["M", format_num(points[0][0], precision), " ", format_num(points[0][1], precision)]
    for x, y in points[1:]:
        out.extend((" L", format_num(x, precision), " ", format_num(y, precision)))
    if closed:
        out.append(" Z")
    return "".join(out)


def is_hidden(parent_hidden: bool, tag: str, attrs: dict[str, str]) -> bool:
    if parent_hidden or tag in {"defs", "clippath", "mask", "symbol", "pattern", "marker"}:
        return True
    if str(attrs.get("display", "")).lower() == "none" or str(attrs.get("visibility", "")).lower() == "hidden":
        return True
    style = attrs.get("style", "")
    return bool(re.search(r"(?:^|;)\s*display\s*:\s*none\s*(?:;|$)", style, re.I) or re.search(r"(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)", style, re.I))


def make_preview_svg(page: PageInfo, lines: list[list[tuple[float, float]]], out_path: str | Path) -> None:
    vb = f"{page.vb_x:g} {page.vb_y:g} {page.vb_w:g} {page.vb_h:g}"
    par = html.escape(page.preserve_aspect_ratio or "xMidYMid meet", quote=True)
    dparts = []
    for line in lines:
        if len(line) < 2:
            continue
        d = [f"M{line[0][0]:.3f} {line[0][1]:.3f}"]
        for x, y in line[1:]:
            d.append(f"L{x:.3f} {y:.3f}")
        dparts.append("".join(d))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{page.width_mm:g}mm" height="{page.height_mm:g}mm" '
        f'viewBox="{vb}" preserveAspectRatio="{par}">'
        f'<rect x="{page.vb_x:g}" y="{page.vb_y:g}" width="{page.vb_w:g}" height="{page.vb_h:g}" fill="white"/>'
        f'<path d="{" ".join(dparts)}" fill="none" stroke="#555" stroke-width="0.7" vector-effect="non-scaling-stroke"/>'
        '</svg>'
    )
    Path(out_path).write_text(svg, encoding="utf-8")


def analyze_svg(path: str | Path, preview_path: str | Path, progress: ProgressFn = None) -> dict:
    path = Path(path)
    _progress(progress, "Leggo SVG…", 0.02)
    text, enc = read_svg_text(path)
    page = get_page_info(text)
    root_to_mm = root_to_mm_matrix(page)
    size = path.stat().st_size
    estimated_points = max(1, math.ceil(size / 18))
    sample_stride = max(1, math.ceil(estimated_points / 60000))
    preview_lines: list[list[tuple[float, float]]] = []
    stack = [("__root__", identity_matrix(), False)]
    path_tags = poly_tags = line_tags = unsupported = transformed = 0
    points = subpaths = 0
    draw_mm = 0.0
    parsed_subpaths = 0

    def consume(local_pts, closed, matrix):
        nonlocal points, subpaths, draw_mm, parsed_subpaths
        if len(local_pts) < 2:
            return
        root_pts = [apply_matrix(matrix, p) for p in local_pts]
        mm_pts = [apply_matrix(root_to_mm, p) for p in root_pts]
        points += len(local_pts)
        subpaths += 1
        parsed_subpaths += 1
        draw_mm += path_length_mm([(p[0], p[1]) for p in mm_pts], closed)
        if len(preview_lines) < 16000:
            arr = [root_pts[i] for i in range(0, len(root_pts), sample_stride)]
            if not arr or arr[-1] != root_pts[-1]:
                arr.append(root_pts[-1])
            if len(arr) >= 2:
                preview_lines.append(arr)
        if parsed_subpaths % 500 == 0:
            _progress(progress, f"Analizzo geometrie… {parsed_subpaths:,} sub-path", None)

    for m in TAG_RE.finditer(text):
        closing = bool(m.group(1))
        raw_name = m.group(2)
        tag = raw_name.split(":")[-1].lower()
        attr_text = m.group(3) or ""
        full = m.group(0)
        self_closing = bool(m.group(4)) or bool(re.search(r"/\s*>$", full))
        if closing:
            for k in range(len(stack) - 1, 0, -1):
                entry = stack.pop()
                if entry[0] == tag:
                    break
            continue
        attrs = parse_attrs(attr_text if len(attr_text) < 1000000 else re.sub(r"\bd\s*=\s*([\"']).*?\1", "", attr_text, flags=re.S))
        parent_matrix, parent_hidden = stack[-1][1], stack[-1][2]
        local_matrix = parse_transform(attrs.get("transform", "")) if attrs.get("transform") else identity_matrix()
        matrix = multiply_matrix(parent_matrix, local_matrix)
        if attrs.get("transform"):
            transformed += 1
        hidden = is_hidden(parent_hidden, tag, attrs)

        if not hidden and tag == "path":
            path_tags += 1
            d = attr_value(full, "d")
            if d:
                if UNSUPPORTED_PATH_RE.search(d):
                    unsupported += 1
                else:
                    ok = walk_linear_path(d, lambda pts, closed: consume(pts, closed, matrix))
                    if not ok:
                        unsupported += 1
        elif not hidden and tag in ("polyline", "polygon"):
            poly_tags += 1
            pts = parse_points_attr(attrs.get("points"))
            consume(pts, tag == "polygon", matrix)
        elif not hidden and tag == "line":
            line_tags += 1
            try:
                p1 = (float(attrs.get("x1", "nan")), float(attrs.get("y1", "nan")))
                p2 = (float(attrs.get("x2", "nan")), float(attrs.get("y2", "nan")))
                if all(math.isfinite(x) for x in (*p1, *p2)):
                    consume([p1, p2], False, matrix)
            except ValueError:
                pass

        if not self_closing and tag in {"svg", "g", "a", "symbol", "defs", "clippath", "mask", "pattern", "marker"}:
            stack.append((tag, matrix, hidden))

    if subpaths == 0 and unsupported == 0:
        raise ValueError("Nessuna geometria lineare compatibile trovata.")
    make_preview_svg(page, preview_lines, preview_path)
    warnings = []
    if not page.explicit_viewbox:
        warnings.append("viewBox assente: il viewport implicito SVG è stato interpretato correttamente in CSS px a 96 dpi.")
    if unsupported:
        warnings.append(f"{unsupported} path con curve/archi non lineari saranno preservati senza modifica.")
    if transformed:
        warnings.append(f"{transformed} trasformazioni SVG rilevate e rispettate.")
    _progress(progress, "Analisi completata.", 1.0)
    return {
        "encoding": enc,
        "page": page.to_dict(),
        "stats": {
            "fileBytes": size,
            "paths": subpaths + unsupported,
            "points": points,
            "drawMm": draw_mm,
            "penLifts": max(0, subpaths + unsupported - 1),
            "unsupported": unsupported,
            "pathTags": path_tags,
            "polyTags": poly_tags,
            "lineTags": line_tags,
            "transformedTags": transformed,
        },
        "warnings": warnings,
        "sampleStride": sample_stride,
    }


def validate_xml(path: str | Path) -> None:
    parser = xml.parsers.expat.ParserCreate()
    with open(path, "rb") as f:
        parser.ParseFile(f)


def optimize_svg(src: str | Path, dst: str | Path, preview_path: str | Path, options: dict, progress: ProgressFn = None) -> dict:
    src, dst = Path(src), Path(dst)
    mode = options.get("mode", "safe")
    if mode == "lossless":
        shutil.copyfile(src, dst)
        analysis = analyze_svg(src, preview_path, progress)
        validate_xml(dst)
        return {
            "pageOk": True,
            "stats": {
                **analysis["stats"],
                "outputBytes": dst.stat().st_size,
                "travelMm": math.nan,
                "reduction": 0.0,
                "removedShort": 0,
            },
            "warnings": analysis["warnings"],
        }

    simplify_mm = max(0.0, float(options.get("simplifyMm", 0.025)))
    min_path_mm = max(0.0, float(options.get("minPathMm", 0.5)))
    dedupe_mm = max(0.0, float(options.get("dedupeMm", 0.002)))
    precision = max(0, min(8, int(options.get("precision", 3))))
    expected_paths = max(1, int(options.get('_expectedPaths', 1) or 1))

    _progress(progress, "Leggo il documento originale…", 0.02)
    text, encoding = read_svg_text(src)
    page = get_page_info(text)
    page_sig = page.signature()
    root_to_mm = root_to_mm_matrix(page)
    mm_to_root = invert_matrix(root_to_mm)
    if mm_to_root is None:
        raise ValueError("Trasformazione pagina non invertibile.")

    size = src.stat().st_size
    estimated_points = max(1, math.ceil(size / 18))
    sample_stride = max(1, math.ceil(estimated_points / 60000))
    preview_lines: list[list[tuple[float, float]]] = []
    stack = [("__root__", identity_matrix(), False)]
    out_parts: list[str] = []
    last_index = 0
    subpaths_kept = points_kept = unsupported = removed_short = 0
    draw_mm = travel_mm = 0.0
    prev_end_mm = None
    processed_subpaths = 0

    def process_subpath(local_pts, closed, matrix, inv):
        nonlocal subpaths_kept, points_kept, removed_short, draw_mm, travel_mm, prev_end_mm, processed_subpaths
        processed_subpaths += 1
        if len(local_pts) < 2:
            return None
        root_pts = [apply_matrix(matrix, p) for p in local_pts]
        mm_pts = [apply_matrix(root_to_mm, p) for p in root_pts]
        records = [(mm_pts[i][0], mm_pts[i][1], root_pts[i][0], root_pts[i][1]) for i in range(len(local_pts))]
        records = dedupe_records(records, dedupe_mm)
        records = simplify_records(records, simplify_mm, closed)
        if len(records) < 2:
            removed_short += 1
            return None
        length = path_length_mm([(p[0], p[1]) for p in records], closed)
        if min_path_mm > 0 and length < min_path_mm:
            removed_short += 1
            return None
        local_out = []
        root_out = []
        for r in records:
            root = (r[2], r[3])
            root_out.append(root)
            local_out.append(apply_matrix(inv, root))
        first_mm = (records[0][0], records[0][1])
        end_mm = (records[-1][0], records[-1][1])
        if prev_end_mm is not None:
            travel_mm += math.hypot(first_mm[0] - prev_end_mm[0], first_mm[1] - prev_end_mm[1])
        prev_end_mm = end_mm
        subpaths_kept += 1
        points_kept += len(records)
        draw_mm += length
        if len(preview_lines) < 16000:
            arr = [root_out[i] for i in range(0, len(root_out), sample_stride)]
            if not arr or arr[-1] != root_out[-1]:
                arr.append(root_out[-1])
            if len(arr) >= 2:
                preview_lines.append(arr)
        if processed_subpaths % 500 == 0:
            _progress(progress, f"Ottimizzo geometrie… {processed_subpaths:,} sub-path", min(0.94, 0.05 + 0.87 * processed_subpaths / expected_paths))
        return serialize_subpath(local_out, closed, precision)

    for m in TAG_RE.finditer(text):
        out_parts.append(text[last_index:m.start()])
        last_index = m.end()
        full = m.group(0)
        closing = bool(m.group(1))
        raw_name = m.group(2)
        tag = raw_name.split(":")[-1].lower()
        attr_text = m.group(3) or ""
        self_closing = bool(m.group(4)) or bool(re.search(r"/\s*>$", full))
        if closing:
            out_parts.append(full)
            for k in range(len(stack) - 1, 0, -1):
                entry = stack.pop()
                if entry[0] == tag:
                    break
            continue

        attrs = parse_attrs(attr_text if len(attr_text) < 1000000 else re.sub(r"\bd\s*=\s*([\"']).*?\1", "", attr_text, flags=re.S))
        parent_matrix, parent_hidden = stack[-1][1], stack[-1][2]
        local_matrix = parse_transform(attrs.get("transform", "")) if attrs.get("transform") else identity_matrix()
        matrix = multiply_matrix(parent_matrix, local_matrix)
        inv = invert_matrix(matrix)
        hidden = is_hidden(parent_hidden, tag, attrs)
        emitted = full

        if not hidden and tag == "path":
            d = attr_value(full, "d")
            if d:
                if inv is None or UNSUPPORTED_PATH_RE.search(d):
                    unsupported += 1
                else:
                    rebuilt: list[str] = []
                    ok = walk_linear_path(d, lambda pts, closed: (lambda x: rebuilt.append(x) if x else None)(process_subpath(pts, closed, matrix, inv)))
                    if ok:
                        emitted = replace_attr(full, "d", " ".join(rebuilt)) if rebuilt else ""
                    else:
                        unsupported += 1
        elif not hidden and tag in ("polyline", "polygon") and inv is not None:
            pts = parse_points_attr(attrs.get("points"))
            d = process_subpath(pts, tag == "polygon", matrix, inv)
            if d:
                nums = re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", d)
                emitted = replace_attr(full, "points", " ".join(f"{nums[i]},{nums[i+1]}" for i in range(0, len(nums)-1, 2)))
            else:
                emitted = ""
        elif not hidden and tag == "line" and inv is not None:
            try:
                pts = [(float(attrs.get("x1", "nan")), float(attrs.get("y1", "nan"))), (float(attrs.get("x2", "nan")), float(attrs.get("y2", "nan")))]
                if all(math.isfinite(x) for p in pts for x in p):
                    if process_subpath(pts, False, matrix, inv) is None:
                        emitted = ""
            except ValueError:
                pass

        out_parts.append(emitted)
        if not self_closing and tag in {"svg", "g", "a", "symbol", "defs", "clippath", "mask", "pattern", "marker"}:
            stack.append((tag, matrix, hidden))

    out_parts.append(text[last_index:])
    output_text = "".join(out_parts)
    out_page = get_page_info(output_text)
    if out_page.signature() != page_sig:
        raise ValueError("Controllo pagina fallito: width/height/viewBox/preserveAspectRatio sono cambiati. Export annullato.")
    dst.write_bytes(output_text.encode(encoding, errors="xmlcharrefreplace"))
    validate_xml(dst)
    if subpaths_kept + unsupported < 1:
        raise ValueError("Il risultato non contiene geometrie visibili. Export annullato.")
    make_preview_svg(page, preview_lines, preview_path)
    output_bytes = dst.stat().st_size
    _progress(progress, "Ottimizzazione completata e SVG validato.", 1.0)
    return {
        "pageOk": True,
        "stats": {
            "paths": subpaths_kept + unsupported,
            "points": points_kept,
            "drawMm": draw_mm,
            "travelMm": travel_mm,
            "penLifts": max(0, subpaths_kept + unsupported - 1),
            "outputBytes": output_bytes,
            "removedShort": removed_short,
            "unsupportedPreserved": unsupported,
            "reduction": 1.0 - output_bytes / max(1, size),
        },
        "warnings": ([f"{unsupported} path non lineari preservati senza modifica."] if unsupported else []),
    }