#!/usr/bin/env bash
set -euo pipefail

# Helper script to download SmolLM2-360M-Instruct and run llama-server locally on host.
# Usage: ./tools/llm.sh

MODEL_DIR="data/models"
MODEL_FILE="${MODEL_DIR}/smollm2-360m-instruct-q4_k_m.gguf"
MODEL_URL="https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf"

mkdir -p "${MODEL_DIR}"

if [[ ! -f "${MODEL_FILE}" || $(stat -c%s "${MODEL_FILE}" 2>/dev/null || echo 0) -lt 100000000 ]]; then
  echo "Downloading SmolLM2-360M (~270 MB) from Hugging Face into ${MODEL_FILE}..."
  rm -f "${MODEL_FILE}" "${MODEL_FILE}.tmp"
  curl -fL --progress-bar -o "${MODEL_FILE}.tmp" "${MODEL_URL}"
  mv "${MODEL_FILE}.tmp" "${MODEL_FILE}"
  echo "Download complete."
fi

if command -v llama-server >/dev/null 2>&1; then
  echo "Starting llama-server natively on :8080 (1 thread, 512 ctx)..."
  exec llama-server -m "${MODEL_FILE}" --host 127.0.0.1 --port 8080 -t 1 -tb 1 -np 1 --ctx-size 512
elif command -v docker >/dev/null 2>&1; then
  TTY_OPTS=()
  [ -t 0 ] && TTY_OPTS=(-it)
  echo "Starting llama-server via docker container on :8080 (1 CPU, 512m RAM limit)..."
  exec docker run --rm "${TTY_OPTS[@]}" \
    -p 8080:8080 \
    --cpus="1.0" \
    --memory="512m" \
    -v "$(pwd)/${MODEL_DIR}:/models" \
    ghcr.io/ggml-org/llama.cpp:server \
    -m "/models/smollm2-360m-instruct-q4_k_m.gguf" \
    --host 0.0.0.0 \
    --port 8080 \
    -t 1 \
    -tb 1 \
    -np 1 \
    --ctx-size 512
else
  echo "Error: Neither llama-server nor docker was found on PATH." >&2
  exit 1
fi
