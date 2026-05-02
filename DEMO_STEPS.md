# Nexus demo: publish on Linux → fetch on Mac

## Linux (publisher): IPFS + agent + reader

1. Start stack (includes IPFS if not running):

   ```bash
   cd /path/to/Nexus-A-Decentralized-and-Immutable-Logging-System
   ./run.sh
   ```

   IPFS is started the same way as `scripts/ipfs-daemon-nexus.sh`:  
   `ipfs daemon --routing=dhtclient` (see `run.sh`).

2. Optional health check:

   ```bash
   chmod +x scripts/ipfs-publisher-health.sh
   ./scripts/ipfs-publisher-health.sh
   ```

3. After a batch is uploaded, confirm the CID is pinned and reachable:

   ```bash
   ipfs pin ls | grep <CID>
   ipfs routing findprovs <CID>
   ```

4. **Firewall / network:** For other machines to load your CIDs from the DHT, allow **TCP 4001** (default swarm) on the Linux host; some setups also use **UDP** for QUIC—check `ipfs config show Addresses.Swarm`.

5. **LAN-only:** If public gateways time out, connect the consumer’s IPFS node to the publisher:

   On Linux: `ipfs id` → copy `ID` and your LAN IP.

   On Mac:

   ```bash
   ipfs swarm connect /ip4/<LINUX_LAN_IP>/tcp/4001/p2p/<PEER_ID>
   ```

## Mac (consumer): UI + resolve IPNS + fetch CID

1. Put the Linux `log-agent` **peer id** in `CLI-NetSecTool/keys/ipns_key.txt` (from Linux:  
   `ipfs key list -l | awk '$NF=="log-agent"{print $1}'`).

2. Start Kubo and the UI:

   ```bash
   ipfs daemon --routing=dhtclient
   cd CLI-NetSecTool && npm install && npm run serve
   ```

3. Open `http://127.0.0.1:6005` → Resolve IPNS → Fetch logs.

## Fetch path (why public gateways sometimes fail)

CLI fetch order is configured in `CLI-NetSecTool/config/settings.json`:

- `connection_mode: "api"` → try **`ipfs cat`** (local repo), then **local gateway** `http://127.0.0.1:8080/ipfs/`, then public gateways.
- If Mac has no `ipfs` CLI, `cat` fails and HTTP gateways are used; use **swarm connect** or open firewall so your Mac node can retrieve blocks from Linux.

Broken hosts like `cloudflare-ipfs.com` are removed from fallbacks (deprecated / DNS issues).
