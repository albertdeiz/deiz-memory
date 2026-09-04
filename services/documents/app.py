"""
Document service: the cheap text lane, plus the rasterizing the visual lane
carril B para hablar con modelos que no aceptan PDF.

Why a container and not a subprocess from the core:

  - markitdown es Python y el core es TypeScript. Con CLI, cada host donde se
    despliegue necesita Python y uv instalados, y el primer arranque baja 44
    paquetes. En un VPS se nota; en una Raspberry Pi es insoportable.
  - Rasterizing PDF pages needs a Python library too. A second container for
    that would split a runtime that is already here in half.

The design anticipated it: a CLI to begin with, a service once the process
molestar, se pasa a un sidecar FastAPI con un POST /convert".
"""
import base64
import io
import os

import pillow_heif
import pypdfium2 as pdfium
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from markitdown import MarkItDown, StreamInfo
from PIL import Image

app = FastAPI(title="deiz-memory · documentos")

# Sin esto Pillow no sabe abrir un HEIC. Se registra una vez, al importar.
pillow_heif.register_heif_opener()

# Sin plugins de terceros: lo que convierte esto tiene que ser predecible.
_md = MarkItDown(enable_plugins=False)

MAX_BYTES = int(os.environ.get("DM_MAX_UPLOAD_BYTES", 100 * 1024 * 1024))
# A 600-page PDF rasterized at 200 DPI is gigabytes of PNG and a bill that
# de tokens absurda. El tope se anuncia en la respuesta, nunca se recorta callado.
MAX_PAGES = int(os.environ.get("DM_MAX_RASTER_PAGES", 20))
DEFAULT_DPI = int(os.environ.get("DM_RASTER_DPI", 150))


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "documents"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> dict:
    """Document to Markdown, structure preserved. Empty is a valid answer: it
    means the file had no text layer and the visual lane's turn has come."""
    raw = await _read(file)
    extension = os.path.splitext(file.filename or "")[1] or None

    info = StreamInfo(
        extension=extension,
        mimetype=file.content_type or None,
        filename=file.filename or None,
    )
    try:
        result = _md.convert_stream(io.BytesIO(raw), stream_info=info)
    except Exception as e:  # noqa: BLE001 - the core decides what to do with it
        raise HTTPException(status_code=422, detail=f"markitdown no pudo con el archivo: {e}") from e

    return {
        "text": result.text_content or "",
        "title": result.title,
        "tool": "markitdown",
        "extension": extension,
    }


@app.post("/transcode")
async def transcode(file: UploadFile = File(...)) -> dict:
    """Convierte una imagen a JPEG.

    Existe por el HEIC. Es el formato por defecto de las fotos de iPhone, y no
    Neither the OCR nor the vision API accepts it, so without this half a
    de fotos entra al sistema y queda muda.

    El original **no se toca** (§3.6): esto devuelve bytes nuevos que el carril
    usa para leer, y el blob guardado sigue siendo el HEIC que mandaste. Si
    something learns to read it natively, a reprocess picks up the quality.
    """
    raw = await _read(file)
    try:
        img = Image.open(io.BytesIO(raw))
        # JPEG no tiene canal alfa; sin esto un HEIC con transparencia revienta.
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"no pude convertir la imagen: {e}") from e

    return {
        "media_type": "image/jpeg",
        "data_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": img.width,
        "height": img.height,
    }


@app.post("/rasterize")
async def rasterize(
    file: UploadFile = File(...),
    dpi: int = Form(DEFAULT_DPI),
    max_pages: int = Form(MAX_PAGES),
) -> dict:
    """PDF pages to PNG.

    It exists because of a real-world asymmetry: one provider accepts a PDF
    entero como bloque `document`, pero el formato de chat de OpenAI —que es lo
    the chat-style API most local servers speak accepts only images. For the
    visual lane to work the same with a local model, someone has to rasterize,
    ese alguien es el runtime que ya tiene pypdfium2 cargado.
    """
    raw = await _read(file)
    try:
        pdf = pdfium.PdfDocument(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"no es un PDF legible: {e}") from e

    total = len(pdf)
    limit = max(1, min(max_pages, MAX_PAGES))
    scale = max(0.5, min(dpi, 300)) / 72

    pages = []
    for i in range(min(total, limit)):
        buf = io.BytesIO()
        pdf[i].render(scale=scale).to_pil().save(buf, format="PNG")
        pages.append({
            "index": i,
            "media_type": "image/png",
            "data_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        })

    return {
        "pages": pages,
        "total_pages": total,
        # Que el recorte viaje en la respuesta y no en un log: quien pregunta
        # has to be able to say "this is incomplete" without guessing.
        "truncated": total > len(pages),
    }


async def _read(file: UploadFile) -> bytes:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"el archivo supera {MAX_BYTES} bytes")
    return raw
