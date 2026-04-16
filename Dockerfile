FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN addgroup --system appgroup && \
    adduser --system --ingroup appgroup appuser && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 5003

CMD ["gunicorn", \
     "--bind", "0.0.0.0:5003", \
     "--workers", "2", \
     "--keep-alive", "2", \
     "--timeout", "30", \
     "--limit-request-line", "4096", \
     "--limit-request-fields", "50", \
     "--limit-request-field_size", "8190", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "--forwarded-allow-ips", "*", \
     "app:app"]
