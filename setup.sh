#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${ROOT_DIR}/RT-SysAgent"
UI_DIR="${ROOT_DIR}/CLI-NetSecTool"

echo "[nexus] setup started"

command -v ipfs >/dev/null 2>&1 || {
  echo "[nexus] ipfs is not installed. Install Kubo first: https://docs.ipfs.tech/install/command-line/"
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "[nexus] node is not installed. Install Node.js 18+ first."
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "[nexus] npm is not installed. Install Node.js/npm first."
  exit 1
}
command -v g++ >/dev/null 2>&1 || {
  echo "[nexus] g++ is not installed. Install build-essential first."
  exit 1
}

if [[ ! -d "${HOME}/.ipfs" ]]; then
  echo "[nexus] initializing ipfs repo"
  ipfs init
fi

if ! ipfs key list -l 2>/dev/null | awk '{print $NF}' | grep -Fxq "log-agent"; then
  echo "[nexus] creating ipfs key: log-agent"
  ipfs key gen log-agent --type=rsa --size=2048 >/dev/null
fi

mkdir -p "${AGENT_DIR}/tmp" "${AGENT_DIR}/logs" "${AGENT_DIR}/keys"
if [[ ! -f "${AGENT_DIR}/keys/private_key.pem" ]]; then
  echo "[nexus] generating rsa keypair for RT-SysAgent"
  openssl genrsa -out "${AGENT_DIR}/keys/private_key.pem" 2048 >/dev/null 2>&1
  openssl rsa -in "${AGENT_DIR}/keys/private_key.pem" -pubout -out "${AGENT_DIR}/keys/public_key.pem" >/dev/null 2>&1
  chmod 600 "${AGENT_DIR}/keys/private_key.pem"
fi

echo "[nexus] building RT-SysAgent"
make -C "${AGENT_DIR}" agent reader config-generator >/dev/null
(cd "${AGENT_DIR}" && ./bin/config_generator >/dev/null) || true

echo "[nexus] installing UI dependencies"
npm --prefix "${UI_DIR}" install >/dev/null

echo "[nexus] setup complete"
