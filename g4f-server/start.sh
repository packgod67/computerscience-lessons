#!/usr/bin/env bash
# Start the gpt4free OpenAI-compatible API server.
# Render provides $PORT; default to 1337 for local dev.
python -m g4f.api run --bind "0.0.0.0:${PORT:-1337}"
