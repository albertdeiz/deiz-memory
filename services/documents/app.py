"""
Sidecar de documentos: el carril A de §8.1, más el rasterizado que necesita el
carril B para hablar con modelos que no aceptan PDF.

Por qué es un contenedor y ya no un `uvx` desde el core:

  - markitdown es Python y el core es TypeScript. Con CLI, cada host donde se
    despliegue necesita Python y uv instalados, y el primer arranque baja 44
    paquetes. En un VPS se nota; en una Raspberry Pi es insoportable.
  - Rasterizar páginas de PDF necesita pypdfium2, que también es Python. Meter
    un segundo contenedor para eso sería partir por la mitad un runtime que ya
    está acá.

§8.1 ya lo dejaba anotado: "CLI al inicio, sidecar después. Si empieza a
molestar, se pasa a un sidecar FastAPI con un POST /convert".
"""
import base64
import io
import os

import pypdfium2 as pdfium
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from markitdown import MarkItDown, StreamInfo

app = FastAPI(title="deiz-memory · documentos")

# Sin plugins de terceros: lo que convierte esto tiene que ser predecible.
_md = MarkItDown(enable_plugins=False)

MAX_BYTES = int(os.environ.get("DM_MAX_UPLOAD_BYTES", 100 * 1024 * 1024))
# Un PDF de 600 páginas rasterizado a 200 DPI son gigabytes de PNG y una cuenta
# de tokens absurda. El tope se anuncia en la respuesta, nunca se recorta callado.
MAX_PAGES = int(os.environ.get("DM_MAX_RASTER_PAGES", 20))
DEFAULT_DPI = int(os.environ.get("DM_RASTER_DPI", 150))


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "documents"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> dict:
    """Documento a Markdown, con la estructura preservada. Vacío es una respuesta
    válida: significa que el archivo no traía capa de texto y que le toca al
    carril de visión."""
    raw = await _read(file)
    extension = os.path.splitext(file.filename or "")[1] or None

    info = StreamInfo(
        extension=extension,
        mimetype=file.content_type or None,
        filename=file.filename or None,
    )
    try:
        result = _md.convert_stream(io.BytesIO(raw), stream_info=info)
    except Exception as e:  # noqa: BLE001 — el core decide qué hacer con el fallo
        raise HTTPException(status_code=422, detail=f"markitdown no pudo con el archivo: {e}") from e

    return {
        "text": result.text_content or "",
        "title": result.title,
        "tool": "markitdown",
        "extension": extension,
    }


@app.post("/rasterize")
async def rasterize(
    file: UploadFile = File(...),
    dpi: int = Form(DEFAULT_DPI),
    max_pages: int = Form(MAX_PAGES),
) -> dict:
    """Páginas de PDF a PNG.

    Existe por una asimetría del mundo real: la API de Anthropic acepta un PDF
    entero como bloque `document`, pero el formato de chat de OpenAI —que es lo
    que hablan Ollama, llama.cpp y vLLM— solo acepta imágenes. Para que el carril
    de visión funcione igual con un modelo local, alguien tiene que rasterizar, y
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
        # tiene que poder decir "esto está incompleto" sin adivinarlo.
        "truncated": total > len(pages),
    }


async def _read(file: UploadFile) -> bytes:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="archivo vacío")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"el archivo supera {MAX_BYTES} bytes")
    return raw
