"""I-1 phase 0 quality spike, step 2: does "red top" find red tops?

Takes the crops from ``i1_crop_dump.py``, embeds them with one or more
open-vocabulary image models (SigLIP / CLIP family, via Hugging Face
``transformers``), runs a fixed list of plain-English queries and writes
``report.html``: for every query and model, the top 20 crops with a tick box.
Tick the correct ones; the page shows precision@20 per query and model and
can copy all the ticks as JSON for the PR.

For colour queries the report also ranks crops by today's heuristic colour
(``crops.csv`` upper/lower colour from ``journey/body.py``) so we can see
whether the embedding beats it.

Needs a Python with torch + transformers (not the AI image):

    python3 -m venv ~/i1-venv && ~/i1-venv/bin/pip install torch transformers pillow sentencepiece protobuf
    ~/i1-venv/bin/python ai/face-service/vms_face/eval/i1_text_search.py --crops ~/i1-spike/crops

Licences of the default models: see docs/investigation/LICENCES.md.
"""
from __future__ import annotations

import sys

# Run as a file, Python puts this folder first on sys.path, and its types.py
# then shadows the standard library's `types`. Drop it before other imports.
_here = __file__.rsplit("/", 1)[0]
sys.path[:] = [p for p in sys.path if p not in ("", _here)]

import argparse  # noqa: E402
import base64  # noqa: E402
import csv  # noqa: E402
import html  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
from pathlib import Path  # noqa: E402

QUERIES: list[tuple[str, str, dict]] = [
    # (key, sentence, heuristic filter on crops.csv or {})
    ("red_top", "a person wearing a red top", {"upper_color": "red"}),
    ("blue_top", "a person wearing a blue top", {"upper_color": "blue"}),
    ("white_top", "a person wearing a white shirt", {"upper_color": "white"}),
    ("black_top", "a person wearing a black jacket", {"upper_color": "black"}),
    ("yellow_top", "a person wearing a yellow top", {"upper_color": "yellow"}),
    ("green_top", "a person wearing a green top", {"upper_color": "green"}),
    ("blue_jeans", "a person wearing blue jeans", {"lower_color": "blue"}),
    ("black_pants", "a person wearing black trousers", {"lower_color": "black"}),
    ("backpack", "a person carrying a backpack", {}),
    ("handbag", "a person carrying a handbag", {}),
    ("suitcase", "a person pulling a suitcase", {}),
    ("helmet", "a person wearing a helmet", {}),
    ("cap", "a person wearing a cap", {}),
    ("saree", "a woman wearing a saree", {}),
    ("kurta", "a man wearing a kurta", {}),
    ("uniform", "a security guard in uniform", {}),
    ("child", "a small child", {}),
    ("phone", "a person talking on a mobile phone", {}),
]

DEFAULT_MODELS = "google/siglip-base-patch16-224,laion/CLIP-ViT-B-32-laion2B-s34B-b79K"
TOP_K = 20


def load_crops(crops_dir: Path):
    from PIL import Image

    rows = list(csv.DictReader(open(crops_dir / "crops.csv")))
    imgs = [Image.open(crops_dir / f"{r['id']}.jpg").convert("RGB") for r in rows]
    return rows, imgs


def embed(model_id: str, imgs, sentences: list[str], device: str):
    import torch
    from transformers import AutoModel, AutoProcessor

    model = AutoModel.from_pretrained(model_id).to(device).eval()
    proc = AutoProcessor.from_pretrained(model_id)
    is_siglip = "siglip" in model_id.lower()
    feats = []
    with torch.no_grad():
        for i in range(0, len(imgs), 32):
            px = proc(images=imgs[i:i + 32], return_tensors="pt").to(device)
            f = _vec(model.get_image_features(**px))
            feats.append(torch.nn.functional.normalize(f, dim=-1).cpu())
        img = torch.cat(feats)
        tx = proc(text=sentences, return_tensors="pt",
                  padding="max_length" if is_siglip else True, truncation=True).to(device)
        txt = torch.nn.functional.normalize(_vec(model.get_text_features(**tx)), dim=-1).cpu()
    return (txt @ img.T).numpy()  # (queries, crops)


def _vec(out):
    """transformers < 5 returns a tensor; 5.x returns an output object whose
    pooler_output is the projected embedding (same vector, once normalised)."""
    return out if hasattr(out, "norm") else out.pooler_output


def thumb(img, h: int = 128) -> str:
    im = img.copy()
    im.thumbnail((h, h))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crops", required=True)
    ap.add_argument("--models", default=DEFAULT_MODELS)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--include-ir", action="store_true", help="also search night/IR crops")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    import torch

    device = ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    crops_dir = Path(args.crops)
    rows, imgs = load_crops(crops_dir)
    if not args.include_ir:
        keep = [i for i, r in enumerate(rows) if r.get("ir") != "1"]
        rows, imgs = [rows[i] for i in keep], [imgs[i] for i in keep]
    print(f"{len(rows)} crops, device {device}")
    thumbs = [thumb(im) for im in imgs]

    sentences = [q[1] for q in QUERIES]
    rankings: dict[str, dict[str, list[int]]] = {}
    for mid in [m for m in args.models.split(",") if m]:
        print(f"embedding with {mid} ...")
        sims = embed(mid, imgs, sentences, device)
        rankings[mid] = {q[0]: list(sims[qi].argsort()[::-1][:TOP_K]) for qi, q in enumerate(QUERIES)}
    rankings["heuristic colour (today)"] = {}
    for key, _, filt in QUERIES:
        if filt:
            hits = [i for i, r in enumerate(rows) if all(r.get(k) == v for k, v in filt.items())]
            rankings["heuristic colour (today)"][key] = hits[:TOP_K]

    out = Path(args.out) if args.out else crops_dir.parent / "report.html"
    out.write_text(render(rows, thumbs, rankings), encoding="utf-8")
    print(f"Open {out} in a browser and tick the correct results.")
    return 0


def render(rows, thumbs, rankings) -> str:
    models = list(rankings)
    parts = [PAGE_HEAD, f"<p>{len(rows)} crops · {len(models)} rankers · top {TOP_K} per query. "
             "Tick every crop that matches the query. Precision updates live.</p>",
             '<p><button id="copy">Copy results as JSON</button> <span id="msg"></span></p>',
             '<table class="sum"><thead><tr><th>Query</th>'
             + "".join(f"<th>{html.escape(m)}</th>" for m in models) + "</tr></thead><tbody>"]
    for key, sentence, _ in QUERIES:
        parts.append(f"<tr><td>{html.escape(sentence)}</td>"
                     + "".join(f'<td class="p" data-m="{html.escape(m)}" data-q="{key}">–</td>' for m in models)
                     + "</tr>")
    parts.append("</tbody></table>")
    for key, sentence, _ in QUERIES:
        parts.append(f"<h2>{html.escape(sentence)}</h2>")
        for m in models:
            idxs = rankings[m].get(key)
            if idxs is None:
                continue
            parts.append(f'<h3>{html.escape(m)}</h3><div class="grid">')
            if not idxs:
                parts.append("<p class='none'>no crops</p>")
            for rank, i in enumerate(idxs, 1):
                r = rows[i]
                cid = f"{m}|{key}|{r['id']}"
                parts.append(
                    f'<label class="cell"><img src="data:image/jpeg;base64,{thumbs[i]}" alt="crop {r["id"]}">'
                    f'<span><input type="checkbox" data-m="{html.escape(m)}" data-q="{key}" '
                    f'data-id="{r["id"]}" id="{html.escape(cid)}"> #{rank} · {html.escape(r["camera"])}</span></label>')
            parts.append("</div>")
    parts.append(PAGE_SCRIPT)
    return "".join(parts)


PAGE_HEAD = """<!doctype html><html><head><meta charset="utf-8"><title>I-1 text search spike</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#f6f7f7;color:#1a1f1e}
h2{margin-top:40px;border-top:1px solid #ccd;padding-top:16px}
h3{font-size:13px;color:#555;margin:14px 0 6px}
.grid{display:flex;flex-wrap:wrap;gap:8px}
.cell{display:flex;flex-direction:column;align-items:center;background:#fff;border:1px solid #dde;border-radius:6px;padding:4px;font-size:11px;cursor:pointer}
.cell img{height:128px}
.cell:has(input:checked){outline:3px solid #0e7c6b}
table.sum{border-collapse:collapse;background:#fff}
.sum td,.sum th{border:1px solid #dde;padding:4px 10px;text-align:left}
.p{font-variant-numeric:tabular-nums}
</style></head><body><h1>I-1 spike: text → person search</h1>"""

PAGE_SCRIPT = """<script>
const KEY='i1-spike-ticks';
function load(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){return {}}}
function save(s){try{localStorage.setItem(KEY,JSON.stringify(s))}catch(e){}}
const state=load();
document.querySelectorAll('input[type=checkbox]').forEach(cb=>{
  cb.checked=!!state[cb.id];
  cb.addEventListener('change',()=>{state[cb.id]=cb.checked;save(state);update()});
});
function update(){
  document.querySelectorAll('td.p').forEach(td=>{
    const boxes=[...document.querySelectorAll(`input[data-m="${CSS.escape(td.dataset.m)}"][data-q="${td.dataset.q}"]`)];
    if(!boxes.length){td.textContent='n/a';return}
    const ok=boxes.filter(b=>b.checked).length;
    td.textContent=`${ok}/${boxes.length}`;
  });
}
update();
document.getElementById('copy').addEventListener('click',()=>{
  const out={};
  document.querySelectorAll('td.p').forEach(td=>{(out[td.dataset.q]??={})[td.dataset.m]=td.textContent});
  const txt=JSON.stringify(out,null,2);
  const msg=document.getElementById('msg');
  navigator.clipboard.writeText(txt).then(()=>msg.textContent='Copied',()=>{msg.textContent='Copy failed; see console';console.log(txt)});
});
</script></body></html>"""


if __name__ == "__main__":
    raise SystemExit(main())
