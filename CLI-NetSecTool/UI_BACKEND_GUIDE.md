# Nexus Web UI — “What each button does” (Under the Hood, no code)

This is a **UI-first** guide for the Nexus project. It explains, for every screen/tab/button in the **CLI-NetSecTool Web UI**, what the user does and what happens **under the hood** (IPNS → CID → IPFS → decrypt → display), without referencing code.

Use this as:
- A deep user guide for your report
- A reference for screenshots (“click this → you should see that”)
- A document you can give another AI to translate into Armenian

This guide focuses on the **Web UI in `CLI-NetSecTool`**, but also explains how it depends on the agent pipeline (`RT-SysAgent`).

---

## Big picture: what the Web UI is actually showing

Nexus stores security logs as **encrypted batches on IPFS** and uses **IPNS** as a “latest pointer”.

So the Web UI is not reading raw system logs directly. Instead, it:

- Finds the **latest batch** by resolving IPNS
- Downloads the batch from IPFS (usually via gateways)
- Decrypts it using your local RSA private key
- Shows the decrypted entries on screen

### Data flow (end-to-end)

1. **Agent** monitors the machine (USB + file deletes + syslog matches) and sends events into a shared memory queue.
2. **Reader** batches events, encrypts them, uploads to IPFS (CID), and updates IPNS “latest pointer”.
3. **Web UI** resolves IPNS → obtains CID → downloads encrypted content by CID → decrypts → shows logs.

---

## Before using the UI (must be true)

To make the buttons work reliably, you need these running/available:

- **IPFS daemon is running**: only one `ipfs daemon` can run at a time.
- **Agent + reader are running** (otherwise there is nothing new to resolve/fetch).
- **The Web UI server is running** (so the browser can talk to it).
- **Keys are present**:
  - The Web UI needs:
    - `CLI-NetSecTool/keys/ipns_key.txt` → contains the **PeerID** for the publishing key (example: `k2k4...`)
    - `CLI-NetSecTool/keys/private_key.pem` → the RSA private key used to decrypt batches

If any of these are missing, you will see errors like “Resolve failed” / “Fetch failed” / “Decryption failed”.

---

## Web UI main screen overview (tabs)

When you open the UI, you will see three main tabs:

- **Fetch Logs**
- **IPNS Keys**
- **Configuration**

There is also:
- A **System Stats** sidebar (uptime, memory, CPU, network)
- A bottom **System Logs** drawer (this is UI/service logs, not the immutable IPFS logs)

Each section below explains **what each button does**, what it needs, what it outputs, and what errors mean.

---

## Fetch Logs tab (the most important tab)

This tab is how you **view immutable logs stored in IPFS**.

### Button: “RESOLVE IPNS”

**What you do**
- Click **RESOLVE IPNS**

**What it means**
- IPNS is a *pointer* that always points to “the latest CID”.
- Your reader updates that pointer continuously as it uploads new batches.

**What happens under the hood**
- The UI reads your IPNS identity (PeerID) from:
  - `CLI-NetSecTool/keys/ipns_key.txt`
- It asks your local IPFS node to resolve:
  - `/ipns/<PeerID>` → `/ipfs/<CID>`
- It returns the **latest CID**.

**What you should see**
- A “RESOLVED CID” box containing a CID like `Qm...`
- Buttons to copy the CID and fetch logs

**Common errors**
- **HTTP 500 on resolve**:
  - `keys/ipns_key.txt` missing/empty/wrong PeerID
  - IPFS daemon not running
  - IPNS has never been published yet (reader hasn’t successfully published)

---

### Button: “FETCH LOGS” (with a CID)

**What you do**
- Paste a CID into the CID input field and click **FETCH LOGS**
  - Or click “Fetch Logs” from the resolved CID box (recommended).

**What happens under the hood**
1. The UI downloads the encrypted batch from IPFS using the CID.
   - It usually uses public gateways (and can try multiple gateways).
2. The downloaded file is an encrypted JSON container containing:
   - encrypted data
   - encrypted AES key
   - IV + authentication tag (AES-GCM)
3. The UI decrypts it locally:
   - RSA private key decrypts the AES key
   - AES-GCM decrypts the payload
4. The UI parses the decrypted payload into log entries.

**What you should see**
- A list of log entries with:
  - **Event ID**
  - **Type** (SYSLOG / USB / SYSTEM)
  - **Message**
  - **Timestamp**

**Common errors**
- **504 / gateway timeout**:
  - A public IPFS gateway is slow or blocked.
  - Fix: use fallback gateways (your config already supports this), retry, or change network.
- **Decryption failed**:
  - Your UI private key does not match what the reader used.
  - Fix: copy keys from `RT-SysAgent/keys/` to `CLI-NetSecTool/keys/`.
- **“Response was not valid JSON”**:
  - The CID did not return the expected encrypted JSON (gateway error page, wrong CID, etc.).

---

### Button: “Chain Fetch” (previous history)

**What you do**
- After fetching logs, if the UI shows “Previous CID: …”, click **Chain Fetch**.

**What it means**
- Each batch contains a pointer to the previous batch CID.
- This creates an evidence chain: newest → older → older → … until the first batch.

**What happens under the hood**
- The UI takes `prev_cid` from the decrypted payload and fetches that CID next.

**What you should see**
- Another group of logs appears (older).

---

## IPNS Keys tab

This tab helps you manage **IPNS identities** (keys) in your local IPFS.

### Button: “Generate Key”

**What you do**
- Type a name and click **Generate Key**

**What it means**
- You are creating a new identity that can publish its own IPNS pointer.
- Think of it as “a new channel name” for “latest logs”.

**What happens under the hood**
- Your machine generates a new RSA keypair inside the local IPFS keychain.
- This key gets a **PeerID** (a string like `k2k4...`).

**What you should see**
- The new key appears in the list.
- You can copy the key’s PeerID.

**Important for Nexus**
- The agent/reader publishes using a key name (commonly `log-agent`).
- The UI resolves using a **PeerID** stored in `keys/ipns_key.txt`.
- If you generate a new key for demo, you must:
  - publish with that key on the reader side, and
  - update `keys/ipns_key.txt` to that key’s PeerID if you want the UI to resolve it.

---

## Configuration tab

This tab lets you view and change settings the UI backend uses.

### Button: “Save Changes”

**What you do**
- Change fields (IPFS timeouts, gateway list, server options, logging).
- Click **Save Changes**

**What happens under the hood**
- The UI validates the configuration format.
- It writes changes to `CLI-NetSecTool/config/settings.json`.
- The running services reload their settings.

**What you should see**
- A success status message.

**Common errors**
- If you delete required fields or break types, save fails (the backend rejects invalid config).

---

## System Stats sidebar (left panel)

This sidebar refreshes periodically and shows:
- system uptime
- server process uptime
- memory usage
- CPU usage
- network interfaces and speeds

**What happens under the hood**
- The UI asks the local server for system/process/network statistics.
- On Linux, network byte counters come from `/sys/class/net/...`.
- Some Wi‑Fi interfaces cannot report “link speed” cleanly; that can show missing/odd speed.

**If you see network permission errors**
- That’s about the stats feature only; it does not affect IPFS log fetching.

---

## System Logs drawer (bottom)

This is a **log viewer for the UI service itself**, not the immutable security logs.

It helps you explain and debug:
- “server started”
- “resolve succeeded/failed”
- “fetch succeeded/failed”
- configuration errors

### Button: “Export”

Downloads the UI/service logs as a JSON file for your report.

### Button: “Clear”

Clears the UI/service log file.

---

## Meaning of the key files (plain language)

### `keys/ipns_key.txt`

- Think of this as: **“which IPNS identity should I follow to find the latest logs?”**
- It contains one value: a PeerID like `k2k4...`.
- Your reader publishes “latest logs” under the corresponding IPNS identity.

---

### `keys/private_key.pem`

- Think of this as: **“the secret key that can open (decrypt) the IPFS log batches.”**
- If this key does not match the encryption used by the reader, the UI can fetch the file but cannot read it.

---

## Common “teacher demo” errors (simple explanation)

### “Resolve IPNS” gives HTTP 500
- IPNS pointer could not be resolved.
- Usually: IPFS daemon not running, or `ipns_key.txt` missing/wrong, or nothing published yet.

### “Fetch Logs” gives 504
- Your CID is fine, but the public IPFS gateway timed out.
- Fix: retry or use multiple gateways (fallback list), or use a different network.

### “Fetch Logs” gives decryption error
- The UI downloaded the encrypted file, but your local private key doesn’t match.
- Fix: copy the same keypair used by the reader into `CLI-NetSecTool/keys/`.

---

## Screenshot checklist (recommended order)

Recommended “story” screenshots:

1. Web UI homepage (tabs visible).
2. Fetch Logs tab: click **RESOLVE IPNS** → show the resolved CID.
3. Fetch Logs tab: click **Fetch Logs** → show decrypted entries list.
4. Fetch Logs tab: show “Previous CID” and click **Chain Fetch** (history).
5. IPNS Keys tab: show existing keys + copy PeerID.
6. Configuration tab: show IPFS gateway settings + “Save Changes”.
7. System Stats sidebar visible.
8. System Logs drawer expanded + Export button.

---

## Appendix: what the UI depends on (files)

If you mention “under the hood” in your report, these are the key files:

- **Configuration**: `CLI-NetSecTool/config/settings.json`
- **IPNS PeerID selector**: `CLI-NetSecTool/keys/ipns_key.txt`
- **Decryption key**: `CLI-NetSecTool/keys/private_key.pem`
- **UI service logs**: `CLI-NetSecTool/logs/app.log`

