---
title: Arcade G4F
emoji: 🎮
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Arcade G4F

OpenAI-compatible API server using [gpt4free](https://github.com/xtekky/gpt4free).
Provides free access to GPT, Claude, Gemini, and other premium models via
reverse-engineered providers.

Used by the [Arcade](https://computerscience-lessons.onrender.com) site's
Kirky chatbot as a bonus LLM tier on top of Groq.

## Endpoint

```
POST https://<your-space>.hf.space/v1/chat/completions
```

OpenAI-compatible format. No API key required.

## Why separate from the arcade?

Hugging Face Spaces gives us a free, always-on Python environment (no
cold starts like Render free tier). g4f breaks too often to put on the
critical path, so the Cloudflare worker tries it first and falls back
to Groq + Pollinations when providers are broken.
