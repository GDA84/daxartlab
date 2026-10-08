from pathlib import Path
import tempfile
from optimizer import analyze_svg, optimize_svg, get_page_info, read_svg_text, validate_xml

CASES = {
    "a4_no_viewbox": '''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm">
<g transform="translate(40,50) scale(1.2)"><path fill="none" stroke="black" d="M0 0 L100 20 L200 60 M10 100 L30 110 L80 130"/></g></svg>''',
    "a3_viewbox": '''<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="420mm" viewBox="0 0 1000 1400" preserveAspectRatio="xMidYMid meet">
<g transform="matrix(0.9 0 0 0.9 30 40)"><path d="M10 10 L100 20 L200 50 L300 80 M100 400 L300 420 L500 460" fill="none" stroke="#000"/></g></svg>''',
    "closed_loop": '''<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 1200 850">
<path d="M100 100 L300 80 L500 120 L600 300 L520 500 L300 540 L120 400 Z" fill="none" stroke="black"/></svg>''',
    "unsupported_curve": '''<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 794 1123">
<path d="M10 10 C100 20 200 30 300 40" fill="none" stroke="black"/></svg>''',
}


def main():
    with tempfile.TemporaryDirectory(prefix="daxart_svg_test_") as td:
        td = Path(td)
        for name, text in CASES.items():
            src = td / f"{name}.svg"
            out = td / f"{name}_out.svg"
            src.write_text(text, encoding="utf-8")
            before, _ = read_svg_text(src)
            sig = get_page_info(before).signature()
            analyze_svg(src, td / f"{name}_preview.svg")
            optimize_svg(src, out, td / f"{name}_opt_preview.svg", {
                "mode": "safe", "simplifyMm": 0.025, "minPathMm": 0,
                "dedupeMm": 0.002, "precision": 3,
            })
            validate_xml(out)
            after, _ = read_svg_text(out)
            assert get_page_info(after).signature() == sig, f"Page changed: {name}"
            print(f"PASS {name}: {src.stat().st_size} -> {out.stat().st_size} bytes")
    print("\nAll regression tests passed.")


if __name__ == "__main__":
    main()