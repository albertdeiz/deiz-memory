# python:3.12-slim publica amd64 y arm64, que es lo que hace posible el mismo
# compose en un VPS y en una Raspberry Pi.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Sin root: el sidecar recibe archivos de fuera y no tiene por qué poder nada.
RUN useradd --create-home --uid 10001 dm && chown -R dm /app
USER dm

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
