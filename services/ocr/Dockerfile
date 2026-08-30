# python:3.12-slim publica amd64 y arm64. Esa es toda la razón por la que este
# servicio usa RapidOCR/ONNXRuntime y no PaddlePaddle: paddlepaddle solo tiene
# rueda manylinux1_x86_64, y con ella este Dockerfile no existiría para ARM.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # ONNXRuntime abre tantos hilos como núcleos ve, y en un host compartido con
    # Postgres y Garage eso perjudica más de lo que acelera.
    OMP_NUM_THREADS=2

WORKDIR /app

COPY requirements.txt .
# rapidocr declara opencv-python, que en una imagen slim exige libGL y compañía.
# opencv-python-headless tiene la misma API sin nada de eso: la imagen queda más
# chica y sin dependencias gráficas que este servicio jamás va a usar.
RUN pip install --no-cache-dir -r requirements.txt \
 && pip uninstall -y opencv-python \
 && pip install --no-cache-dir opencv-python-headless==4.11.0.86

COPY app.py .

# Los modelos vienen dentro del wheel de rapidocr, así que no hay descarga que
# hacer — pero sí conviene ejercitarlos en el build: si alguna vez faltaran, o
# onnxruntime no cargara en esta arquitectura, es mejor que falle acá y no en la
# primera foto que mandes.
RUN python -c "\
from PIL import Image; import io; from rapidocr import RapidOCR; \
buf = io.BytesIO(); Image.new('RGB', (64, 32), 'white').save(buf, format='PNG'); \
RapidOCR()(buf.getvalue()); print('modelos listos')"

RUN useradd --create-home --uid 10001 dm && chown -R dm /app
USER dm

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
