"""Writes sample.pdf for the PDF browser check: three letter-size pages of
plain Helvetica text, built by hand so no PDF library is needed. The word
"needle" appears once on page 1 and twice on page 3."""

from pathlib import Path

pages = [
    ["Sample paper", "The first page holds one needle in its text."],
    ["Second page", "Nothing to find here at all."],
    ["Third page", "A needle again, and one more needle below.", "The end."],
]


def stream(lines):
    out = ["BT", "/F1 14 Tf", "72 720 Td", "18 TL"]
    for line in lines:
        out.append("(" + line.replace("(", "").replace(")", "") + ") Tj T*")
    out.append("ET")
    return "\n".join(out).encode()


objs = []  # bodies, numbered from 1
objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(len(pages)))
objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
for i, lines in enumerate(pages):
    content = 5 + 2 * i
    objs.append(
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content} 0 R >>".encode()
    )
    s = stream(lines)
    objs.append(b"<< /Length " + str(len(s)).encode() + b" >>\nstream\n" + s + b"\nendstream")

pdf = bytearray(b"%PDF-1.4\n")
offsets = []
for n, body in enumerate(objs, 1):
    offsets.append(len(pdf))
    pdf += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
xref = len(pdf)
pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
for off in offsets:
    pdf += f"{off:010d} 00000 n \n".encode()
pdf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()

Path(__file__).with_name("sample.pdf").write_bytes(bytes(pdf))
