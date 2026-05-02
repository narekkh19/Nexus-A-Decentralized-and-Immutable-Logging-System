#!/usr/bin/env bash
# Nexus: quick IPFS publisher checks on Linux (Kubo).
# Run from repo root or anywhere; requires `ipfs` in PATH and a running daemon.

set -euo pipefail

echo "== ipfs version / identity =="
ipfs version 2>/dev/null || { echo "ipfs not found in PATH"; exit 1; }
ipfs id --format="<id>\n" 2>/dev/null | head -1 || true

echo ""
echo "== swarm (TCP 4001 is default; UDP quic often used too) =="
ipfs swarm peers 2>/dev/null | head -5 || echo "(no peers or daemon down)"
echo "... (truncated)"

echo ""
echo "== pins (sample) =="
ipfs pin ls --type=recursive 2>/dev/null | head -10 || true

echo ""
echo "Usage after publishing a CID:"
echo "  ipfs routing findprovs <CID>    # see if providers are visible on DHT"
echo "  ipfs pin ls | grep <CID>        # confirm local pin"
echo "  ss -tlnp | grep 4001            # swarm listener (or: ipfs config Addresses.Swarm)"
echo ""
echo "Firewall: allow inbound TCP 4001 (and UDP if your Kubo uses QUIC) for other nodes to"
echo "retrieve blocks you added. LAN-only: use 'ipfs id' on publisher, then on consumer:"
echo "  ipfs swarm connect /ip4/<PUB_IP>/tcp/4001/p2p/<PEER_ID>"
