"""
Servicio de OCR: el carril B (§8.1) sin salir del host y sin pagar por foto.

Why OCR and not a vision model, which is the first thing one thinks of:

For PRINTED documents - receipts, policies, ID cards - classical OCR is not
alcanza: gana. Los modelos multimodales chicos leen bien el texto corrido y se
equivocan justo donde no hay que equivocarse, en cadenas que no se pueden
guessed from context: a policy number, a tax id, an amount. A model that
invents a digit with confidence is exactly the failure mode this system
dura 2 existe para evitar, y es peor que no transcribir.

And why this engine and not the better-known one: they run the same models.
modelos (PP-OCRv6), pero corriendo sobre ONNXRuntime en vez de PaddlePaddle.
La diferencia es decisiva para este proyecto: `paddlepaddle` solo publica rueda
x86_64 only - there is no arm64 wheel - while the runtime used here does
`manylinux_2_28_aarch64`. Misma calidad de lectura, y el mismo compose corre en
un VPS y en una Raspberry Pi.

What this lane does NOT do, and why the model-backed one still exists:
handwriting.
Para una receta escrita a mano un modelo multimodal es mejor.
"""
import os
from statistics import median

from fastapi import FastAPI, File, HTTPException, UploadFile
from rapidocr import RapidOCR

app = FastAPI(title="deiz-memory · ocr")

_engine = RapidOCR()

MAX_BYTES = int(os.environ.get("DM_MAX_UPLOAD_BYTES", 50 * 1024 * 1024))
# Debajo de esto la lectura es dudosa y conviene marcarla para reprocesar, no
# guardarla como si fuera confiable.
LOW_CONFIDENCE = float(os.environ.get("DM_OCR_MIN_CONFIDENCE", 0.6))


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "ocr", "engine": "rapidocr/PP-OCRv6"}


@app.post("/ocr")
async def ocr(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"el archivo supera {MAX_BYTES} bytes")

    try:
        # bytes directo: RapidOCR no acepta BytesIO (str, ndarray, bytes, Path o PIL).
        result = _engine(raw)
    except Exception as e:  # noqa: BLE001 - the core decides what to do with it
        raise HTTPException(status_code=422, detail=f"el OCR no pudo con la imagen: {e}") from e

    txts = list(result.txts or [])
    scores = [float(s) for s in (result.scores or [])]
    boxes = list(result.boxes) if result.boxes is not None else []

    lines = _in_reading_order(txts, scores, boxes)
    text = "\n".join(l["text"] for l in lines)
    mean = sum(scores) / len(scores) if scores else 0.0

    return {
        "text": text,
        "lines": lines,
        "mean_confidence": round(mean, 4),
        # The service saying "I read this badly" beats making the core
        # el core lo adivine desde el largo del texto.
        "low_confidence": bool(scores) and mean < LOW_CONFIDENCE,
        "engine": "rapidocr/PP-OCRv6",
    }


def _in_reading_order(txts, scores, boxes) -> list[dict]:
    """Ordena los trozos detectados de arriba a abajo y de izquierda a derecha.

    RapidOCR ya devuelve algo parecido al orden de lectura, pero en un documento
    two-column layout - a policy, typically - the raw order interleaves the
    columns. Lines are grouped into vertical bands using the median line height:
    a simple, predictable heuristic that does not try to rebuild tables.
    """
    if not txts:
        return []
    if len(boxes) != len(txts):
        return [{"text": t, "score": s} for t, s in zip(txts, scores)]

    tops = [min(p[1] for p in b) for b in boxes]
    lefts = [min(p[0] for p in b) for b in boxes]
    heights = [max(p[1] for p in b) - min(p[1] for p in b) for b in boxes]
    band = max(median(heights) * 0.6, 1.0) if heights else 1.0

    order = sorted(range(len(txts)), key=lambda i: (round(tops[i] / band), lefts[i]))
    return [
        {"text": txts[i], "score": round(float(scores[i]), 4) if i < len(scores) else None}
        for i in order
    ]
