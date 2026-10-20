#!/usr/bin/env bash
set -euo pipefail

# Helper script to download SmolLM2-360M-Instruct and run llama-server locally on host.
# Usage: ./tools/llm.sh

MODEL_DIR="data/models"
MODEL_FILE="${MODEL_DIR}/smollm2-360m-instruct-q4_k_m.gguf"
MODEL_URL="https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q4_k_m.gguf"

mkdir -p "${MODEL_DIR}"

if [[ ! -f "${MODEL_FILE}" ]]; then
  echo "Downloading SmolLM2-360M (~230 MB) from Hugging Face into ${MODEL_FILE}..."
  curl -L --progress-bar -o "${MODEL_FILE}" "${MODEL_URL}"
  echo "Download complete."
fi

if command -v llama-server >/dev/null 2>&1; then
  echo "Starting llama-server natively on :8080..."
  exec llama-server -m "${MODEL_FILE}" --host 127.0.0.1 --port 8080 -t 2 -tb 2 --ctx-size 1024
elif command -v docker >/dev/null 2>&1; then
  echo "Starting llama-server via docker container on :8080..."
  exec docker run --rm -it \
    -p 8080:8080 \
    -v "$(pwd)/${MODEL_DIR}:/models" \
    ghcr.io/ggml-org/llama.cpp:server \
    -m "/models/smollm2-360m-instruct-q4_k_m.gguf" \
    --host 0.0.0.0 \
    --port 8080 \
    -t 2 \
    -tb 2 \
    --ctx-size 1024
else
  echo "Error: Neither llama-server nor docker was found on PATH." >&2
  exit 1
fi
