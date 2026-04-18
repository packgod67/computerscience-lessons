# gpt4free API server — designed for Hugging Face Spaces (Docker SDK).
# Also works on any Docker-compatible host.

FROM python:3.11-slim

# curl_cffi (used by g4f) needs libcurl + build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gcc \
        libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Hugging Face Spaces routes public traffic to port 7860 by default.
# Render and most other hosts provide $PORT which we fall back to.
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "g4f api --bind 0.0.0.0:${PORT}"]
