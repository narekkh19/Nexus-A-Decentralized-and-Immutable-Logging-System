#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${ROOT_DIR}/RT-SysAgent"
UI_DIR="${ROOT_DIR}/CLI-NetSecTool"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
mkdir -p "${RUNTIME_DIR}"

IPFS_LOG="${RUNTIME_DIR}/ipfs.log"
AGENT_LOG="${RUNTIME_DIR}/agent.log"
READER_LOG="${RUNTIME_DIR}/reader.log"
UI_LOG="${RUNTIME_DIR}/ui.log"

is_running() {
  local pid_file="$1"
  [[ -f "${pid_file}" ]] || return 1
  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

start_ipfs_if_needed() {
  if ipfs swarm peers >/dev/null 2>&1; then
    echo "[nexus] ipfs daemon already running"
    return
  fi
  echo "[nexus] starting ipfs daemon"
  nohup ipfs daemon --routing=dhtclient >"${IPFS_LOG}" 2>&1 &
  echo $! > "${RUNTIME_DIR}/ipfs.pid"

  for _ in {1..20}; do
    if ipfs swarm peers >/dev/null 2>&1; then
      echo "[nexus] ipfs daemon is ready"
      return
    fi
    sleep 1
  done

  echo "[nexus] ipfs did not become ready in time. Check ${IPFS_LOG}"
  exit 1
}

cleanup_stale_monitors() {
  # Prevent conflicts with old hackathon copies running elsewhere.
  pkill -f "RT-SysAgent/bin/reader" 2>/dev/null || true
  pkill -f "RT-SysAgent/bin/agent" 2>/dev/null || true
  sleep 1
}

start_agent() {
  local pid_file="${RUNTIME_DIR}/agent.pid"
  if is_running "${pid_file}"; then
    echo "[nexus] agent already running"
    return
  fi

  echo "[nexus] starting agent with sudo"
  if ! sudo -n true 2>/dev/null; then
    echo "[nexus] sudo access is required for agent. Enter password once."
    sudo -v
  fi
  nohup bash -c "cd \"${AGENT_DIR}\" && exec stdbuf -oL -eL sudo ./bin/agent" >"${AGENT_LOG}" 2>&1 &
  echo $! > "${pid_file}"
}

start_reader() {
  local pid_file="${RUNTIME_DIR}/reader.pid"
  if is_running "${pid_file}"; then
    echo "[nexus] reader already running"
    return
  fi

  echo "[nexus] starting reader"
  nohup bash -c "cd \"${AGENT_DIR}\" && exec stdbuf -oL -eL ./bin/reader" >"${READER_LOG}" 2>&1 &
  echo $! > "${pid_file}"
}

start_ui() {
  local pid_file="${RUNTIME_DIR}/ui.pid"
  if is_running "${pid_file}"; then
    echo "[nexus] UI server already running"
    return
  fi

  echo "[nexus] starting UI server"
  nohup npm --prefix "${UI_DIR}" run serve >"${UI_LOG}" 2>&1 &
  echo $! > "${pid_file}"
}

if [[ ! -x "${ROOT_DIR}/setup.sh" ]]; then
  chmod +x "${ROOT_DIR}/setup.sh"
fi
"${ROOT_DIR}/setup.sh"

start_ipfs_if_needed
cleanup_stale_monitors
start_agent
start_reader
start_ui

echo ""
echo "[nexus] demo stack is up"
echo "[nexus] UI: http://127.0.0.1:6005"
echo "[nexus] logs: ${RUNTIME_DIR}"
echo "[nexus] to stop manually: kill \$(cat ${RUNTIME_DIR}/*.pid)"
