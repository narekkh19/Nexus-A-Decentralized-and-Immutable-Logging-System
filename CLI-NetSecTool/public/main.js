// Matrix background animation
const canvas = document.getElementById('matrix-bg');
const ctx = canvas.getContext('2d');

let width = canvas.width = window.innerWidth;
let height = canvas.height = window.innerHeight;

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()';
const charSize = 14;
const columns = width / charSize;
const drops = [];

for (let i = 0; i < columns; i++) {
    drops[i] = 1;
}

// Draw matrix rain effect
function drawMatrix() {
    ctx.fillStyle = 'rgba(10, 10, 10, 0.05)';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#0f0';
    ctx.font = `${charSize}px 'Share Tech Mono'`;

    for (let i = 0; i < drops.length; i++) {
        const text = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(text, i * charSize, drops[i] * charSize);

        if (drops[i] * charSize > height && Math.random() > 0.975) {
            drops[i] = 0;
        }
        drops[i]++;
    }
}

// Handle window resize
window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
});

// UI Elements
const cidInput = document.getElementById('cid-input');
const fetchBtn = document.getElementById('fetch-btn');
const resolveBtn = document.getElementById('resolve-btn');
const logsOutput = document.getElementById('logs-output');
const status = document.getElementById('status');
const statusText = document.getElementById('status-text');
const newKeyNameInput = document.getElementById('new-key-name');
const generateKeyBtn = document.getElementById('generate-key-btn');
const keysList = document.getElementById('keys-list');
const configEditor = document.getElementById('config-editor');
const saveConfigBtn = document.getElementById('save-config-btn');
const refreshStatsBtn = document.getElementById('refresh-stats-btn');
const systemStats = document.getElementById('system-stats');
const flowResolveStep = document.getElementById('flow-step-resolve');
const flowFetchStep = document.getElementById('flow-step-fetch');
const flowShowStep = document.getElementById('flow-step-show');
const logTypeFilter = document.getElementById('log-type-filter');
const logSortOrder = document.getElementById('log-sort-order');
const refreshDistributionBtn = document.getElementById('refresh-distribution-btn');
const distributionCidLabel = document.getElementById('distribution-cid-label');
const worldMap = document.getElementById('world-map');
const gatewayGrid = document.getElementById('gateway-grid');
const hostGrid = document.getElementById('host-grid');
const hostOverviewSummary = document.getElementById('host-overview-summary');
const timelineGrid = document.getElementById('timeline-grid');
const timelineSummary = document.getElementById('timeline-summary');

let appInitialized = false;
let isResolving = false;
let isFetching = false;
let latestFetchedLogs = [];
let latestResolvedCid = '';
let latestPrevCid = '';
let resolveCooldownUntil = 0;

function activateTab(tabName) {
    if (!tabName) return;
    document.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach((c) => {
        const isActive = c.dataset.tab === tabName;
        c.classList.toggle('active', isActive);
        // Hard fallback so tab content still opens even if CSS class handling breaks.
        c.style.display = isActive ? 'block' : 'none';
    });

    if (tabName === 'keys') loadKeys();
    if (tabName === 'timeline') renderIncidentTimeline();
    if (tabName === 'overview') renderHostOverview();
}

// Tab handling (event delegation for reliability)
document.addEventListener('click', (event) => {
    const tabEl = event.target.closest('.tab');
    if (!tabEl) return;
    activateTab(tabEl.dataset.tab);
});

// Show status message
function showStatus(message, isError = false) {
    status.style.display = 'flex';
    status.style.alignItems = 'center';
    statusText.textContent = message;
    if (isError) {
        status.style.borderColor = 'var(--error)';
        status.style.color = 'var(--error)';
    } else {
        status.style.borderColor = 'var(--primary)';
        status.style.color = 'var(--text)';
    }
    setTimeout(() => {
        status.style.display = 'none';
    }, 3000);
}

function parseRawLog(rawLog) {
    try {
        return typeof rawLog === 'string' ? JSON.parse(rawLog) : rawLog;
    } catch (_err) {
        return null;
    }
}

function normalizedType(logObj) {
    if (!logObj) return 'UNKNOWN';
    const rawType = (logObj.type || '').toUpperCase();
    const message = (logObj.message || '').toLowerCase();
    if (rawType === 'SYSTEM' && message.startsWith('deleted file:')) {
        return 'FILE_DELETE';
    }
    return rawType || 'UNKNOWN';
}

function isNoisySyslog(logObj) {
    if (!logObj || normalizedType(logObj) !== 'SYSLOG') return false;
    const message = (logObj.message || '').toLowerCase();
    return message.includes('tracker-miner-fs-3') &&
        message.includes('glib-gio-warning') &&
        message.includes('/proc/self/mountinfo');
}

function setFlowStep(step) {
    if (!flowResolveStep || !flowFetchStep || !flowShowStep) return;
    [flowResolveStep, flowFetchStep, flowShowStep].forEach((el) => el.classList.remove('active'));
    if (step === 'resolve') flowResolveStep.classList.add('active');
    if (step === 'fetch') flowFetchStep.classList.add('active');
    if (step === 'show') flowShowStep.classList.add('active');
}

function setButtonLoading(button, loadingText, defaultText, loading) {
    if (!button) return;
    button.disabled = loading;
    button.textContent = loading ? loadingText : defaultText;
}

function getTypeFromRawLog(rawLog) {
    const parsed = parseRawLog(rawLog);
    return normalizedType(parsed);
}

function compareLogsBySort(a, b) {
    const mode = logSortOrder?.value || 'event_desc';
    const aObj = parseRawLog(a) || {};
    const bObj = parseRawLog(b) || {};
    const aEvent = Number(aObj.event_id || 0);
    const bEvent = Number(bObj.event_id || 0);
    const aTime = new Date(aObj.timestamp || 0).getTime();
    const bTime = new Date(bObj.timestamp || 0).getTime();

    if (mode === 'event_asc') return aEvent - bEvent;
    if (mode === 'time_desc') return bTime - aTime;
    if (mode === 'time_asc') return aTime - bTime;
    return bEvent - aEvent;
}

function applyFetchFilters(rawLogs) {
    const selectedType = logTypeFilter?.value || 'ALL';
    return rawLogs
        .filter((raw) => {
            const parsed = parseRawLog(raw);
            if (!parsed) return false;
            if (isNoisySyslog(parsed)) return false;
            return selectedType === 'ALL' || getTypeFromRawLog(raw) === selectedType;
        })
        .sort(compareLogsBySort);
}

function clearFetchResultsArea() {
    if (!logsOutput || !loading?.overlay) return;
    Array.from(logsOutput.children)
        .filter(node => node !== loading.overlay)
        .forEach(node => node.remove());
}

function renderFetchedLogs() {
    clearFetchResultsArea();
    renderHostOverview();
    renderIncidentTimeline();
    const sortedLogs = applyFetchFilters(latestFetchedLogs);

    if (!sortedLogs.length) {
        const emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = `
            padding: 1rem;
            border: 1px dashed var(--primary-dark);
            border-radius: 6px;
            color: var(--text-secondary);
            margin-bottom: 1rem;
        `;
        emptyDiv.textContent = 'No logs match current filters.';
        logsOutput.insertBefore(emptyDiv, loading.overlay);
        return;
    }

    const logsGroup = document.createElement('div');
    logsGroup.className = 'logs-group';
    logsGroup.style.marginBottom = '1.5rem';

    for (const raw of sortedLogs) {
        const entry = createLogEntry(raw);
        if (entry) logsGroup.appendChild(entry);
    }
    logsOutput.insertBefore(logsGroup, loading.overlay);

    if (latestPrevCid) {
        const navInfo = document.createElement('div');
        navInfo.style.cssText = `
            color: var(--primary);
            padding: 1rem;
            border-top: 1px solid var(--primary);
            margin-top: 1rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
        `;

        const cidText = document.createElement('div');
        cidText.style.cssText = `
            font-family: 'Share Tech Mono', monospace;
            word-break: break-all;
            flex: 1;
        `;
        cidText.textContent = `Previous CID: ${latestPrevCid}`;

        const chainButton = document.createElement('button');
        chainButton.className = 'primary';
        chainButton.style.cssText = `
            width: 150px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        chainButton.innerHTML = 'Chain Fetch';

        const hasZeroId = sortedLogs.some(log => {
            const parsedLog = parseRawLog(log);
            return parsedLog?.event_id === 0;
        });

        if (hasZeroId) {
            chainButton.disabled = true;
            chainButton.style.opacity = '0.5';
            chainButton.style.cursor = 'not-allowed';
            chainButton.title = 'Reached the beginning of the chain';
        } else {
            chainButton.onclick = () => {
                cidInput.value = latestPrevCid;
                fetchLogs(latestPrevCid);
            };
        }

        navInfo.appendChild(cidText);
        navInfo.appendChild(chainButton);
        logsOutput.insertBefore(navInfo, loading.overlay);
    }
}

function regionByGateway(gateway) {
    const host = (() => {
        try { return new URL(gateway).hostname; } catch (_e) { return ''; }
    })();
    if (host.includes('cloudflare')) return { name: 'EU', x: 48, y: 35 };
    if (host.includes('nftstorage')) return { name: 'US', x: 24, y: 40 };
    if (host.includes('dweb')) return { name: 'APAC', x: 76, y: 52 };
    if (host.includes('ipfs.io')) return { name: 'US', x: 28, y: 44 };
    return { name: 'Unknown', x: 52, y: 50 };
}

function stableHash(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return h >>> 0;
}

function mapPointForGateway(gateway, cid = '') {
    const base = regionByGateway(gateway);
    const seed = stableHash(`${gateway}|${cid}`);
    const xJitter = ((seed % 1000) / 1000 - 0.5) * 7;
    const yJitter = ((((seed >> 10) % 1000) / 1000) - 0.5) * 5;
    return {
        name: base.name,
        x: Math.min(95, Math.max(5, base.x + xJitter)),
        y: Math.min(90, Math.max(8, base.y + yJitter))
    };
}

function trimStr(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function structuredHostFromLog(log) {
    if (!log || typeof log !== 'object') return '';
    return trimStr(log.host || log.hostname || log.agent_host || log.agentHost);
}

function extractHostFromSyslogMessage(message) {
    if (!message || typeof message !== 'string') return '';
    const parts = message.trim().split(/\s+/);
    if (parts.length >= 4 && /^\d{4}-\d{2}-\d{2}T/.test(parts[0])) return parts[1];
    return '';
}

function extractHostFromMessage(message) {
    if (!message || typeof message !== 'string') return 'unknown-host';
    const fromIso = extractHostFromSyslogMessage(message);
    if (fromIso) return fromIso;
    const parts = message.trim().split(/\s+/);
    if (parts.length >= 1) return parts[0];
    return 'unknown-host';
}

function sortLogsChronologically(logs) {
    return [...logs].sort((a, b) => {
        const ta = new Date(a.timestamp || 0).getTime();
        const tb = new Date(b.timestamp || 0).getTime();
        if (ta !== tb) return ta - tb;
        return Number(a.event_id || 0) - Number(b.event_id || 0);
    });
}

function resolveHostForLog(log, carryHost) {
    const structured = structuredHostFromLog(log);
    if (structured) return structured;

    const kind = normalizedType(log);
    const msg = (log.message || '').toLowerCase();
    const fromSyslogLine = extractHostFromSyslogMessage(log.message || '');
    if (kind === 'SYSLOG' && fromSyslogLine) return fromSyslogLine;

    if (kind === 'FILE_DELETE' || msg.startsWith('deleted file:')) {
        if (carryHost && carryHost !== 'unknown-host') return carryHost;
    }

    return extractHostFromMessage(log.message);
}

function renderHostOverview() {
    if (!hostGrid || !hostOverviewSummary) return;
    hostGrid.innerHTML = '';

    const parsed = latestFetchedLogs.map(parseRawLog).filter(Boolean);
    if (!parsed.length) {
        hostOverviewSummary.textContent = 'No host data yet';
        hostGrid.innerHTML = '<div class="host-card"><div class="host-title">No data</div><div class="host-metrics">Fetch logs to populate the host overview.</div></div>';
        return;
    }

    const byHost = new Map();
    let carryHost = 'unknown-host';
    for (const log of sortLogsChronologically(parsed)) {
        const host = resolveHostForLog(log, carryHost);
        if (host && host !== 'unknown-host') carryHost = host;

        if (!byHost.has(host)) {
            byHost.set(host, { total: 0, fileDelete: 0, syslog: 0, usb: 0, lastSeen: '' });
        }
        const row = byHost.get(host);
        row.total += 1;
        const kind = normalizedType(log);
        if (kind === 'FILE_DELETE') row.fileDelete += 1;
        if (kind === 'SYSLOG') row.syslog += 1;
        if (kind === 'USB') row.usb += 1;
        if (!row.lastSeen || new Date(log.timestamp) > new Date(row.lastSeen)) row.lastSeen = log.timestamp;
    }

    hostOverviewSummary.textContent = `${byHost.size} host(s), ${parsed.length} event(s) in the current batch`;

    for (const [host, m] of byHost.entries()) {
        const card = document.createElement('div');
        card.className = 'host-card';
        card.innerHTML = `
            <div class="host-title">${host}</div>
            <div class="host-metrics">
                Total: ${m.total}<br>
                File deletes: ${m.fileDelete}<br>
                Syslog: ${m.syslog}<br>
                USB: ${m.usb}<br>
                Last seen (UTC): ${m.lastSeen || 'n/a'}
            </div>
        `;
        hostGrid.appendChild(card);
    }
}

function renderFallbackMapState() {
    if (!worldMap || !gatewayGrid || !distributionCidLabel) return;
    distributionCidLabel.textContent = 'CID: not resolved yet';
    worldMap.innerHTML = '';
    gatewayGrid.innerHTML = '<div class="gateway-card">Resolve IPNS to probe gateway distribution.</div>';
    const fallback = [
        { x: 24, y: 40, name: 'US' },
        { x: 48, y: 35, name: 'EU' },
        { x: 76, y: 52, name: 'APAC' }
    ];
    fallback.forEach((r) => {
        const dot = document.createElement('div');
        dot.className = 'region-dot';
        dot.style.background = '#3b3b3b';
        dot.style.left = `${r.x}%`;
        dot.style.top = `${r.y}%`;
        dot.title = `${r.name} (waiting for probe)`;
        worldMap.appendChild(dot);

        const label = document.createElement('div');
        label.className = 'region-label';
        label.style.left = `${r.x}%`;
        label.style.top = `${r.y}%`;
        label.textContent = r.name;
        worldMap.appendChild(label);
    });
}

function renderIncidentTimeline() {
    if (!timelineGrid || !timelineSummary) return;
    timelineGrid.innerHTML = '';
    const parsed = latestFetchedLogs.map(parseRawLog).filter(Boolean);
    if (!parsed.length) {
        timelineSummary.textContent = 'No incidents loaded';
        timelineGrid.innerHTML = '<div class="timeline-card"><div class="timeline-title">No Data</div><div class="timeline-content">Fetch logs to build the timeline.</div></div>';
        return;
    }

    const grouped = new Map();
    parsed.forEach((log) => {
        const key = (log.timestamp || '').slice(0, 16) || 'unknown-time';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(log);
    });
    const orderedKeys = [...grouped.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 8);
    timelineSummary.textContent = `${parsed.length} events grouped into ${orderedKeys.length} time windows`;

    orderedKeys.forEach((key) => {
        const rows = grouped.get(key);
        const deletes = rows.filter(r => normalizedType(r) === 'FILE_DELETE').length;
        const syslog = rows.filter(r => normalizedType(r) === 'SYSLOG').length;
        const usb = rows.filter(r => normalizedType(r) === 'USB').length;
        const card = document.createElement('div');
        card.className = 'timeline-card';
        card.innerHTML = `
            <div class="timeline-title">${key.replace('T', ' ')}</div>
            <div class="timeline-content">
                total: ${rows.length}<br>
                file_delete: ${deletes}<br>
                syslog: ${syslog}<br>
                usb: ${usb}
            </div>
        `;
        timelineGrid.appendChild(card);
    });
}

async function loadDistribution(cid) {
    if (!cid || !distributionCidLabel || !worldMap || !gatewayGrid) return;
    distributionCidLabel.textContent = `CID: ${cid}`;
    gatewayGrid.innerHTML = '<div class="gateway-card">Loading gateway probes...</div>';
    worldMap.innerHTML = '';

    try {
        const res = await fetch(`/api/distribution?cid=${encodeURIComponent(cid)}`);
        const payload = await res.json();
        if (!payload.success) throw new Error(payload.error || 'Distribution fetch failed');

        gatewayGrid.innerHTML = '';
        payload.gateways.forEach((g) => {
            const region = mapPointForGateway(g.gateway, cid);
            const dot = document.createElement('div');
            dot.className = `region-dot ${g.ok ? 'ok' : 'fail'}`;
            dot.style.left = `${region.x}%`;
            dot.style.top = `${region.y}%`;
            dot.title = `${region.name}: ${g.gateway}`;
            worldMap.appendChild(dot);

            const label = document.createElement('div');
            label.className = 'region-label';
            label.style.left = `${region.x}%`;
            label.style.top = `${region.y}%`;
            label.textContent = region.name;
            worldMap.appendChild(label);

            const card = document.createElement('div');
            card.className = 'gateway-card';
            card.innerHTML = `
                <div>${g.gateway}</div>
                <div class="${g.ok ? 'status-ok' : 'status-fail'}">${g.ok ? 'reachable' : 'unreachable'} (${g.status || 'n/a'})</div>
                <div>latency: ${g.latency_ms} ms | region: ${region.name}</div>
            `;
            gatewayGrid.appendChild(card);
        });
    } catch (error) {
        gatewayGrid.innerHTML = `<div class="gateway-card status-fail">Distribution check failed: ${error.message}</div>`;
    }
}

// Create log entry element
function createLogEntry(log) {
    log = parseRawLog(log);
    if (!log) return null;
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const header = document.createElement('div');
    header.className = 'log-header';
    const eventId = document.createElement('span');
    eventId.textContent = `Event ID: ${log.event_id}`;
    
    const type = document.createElement('span');
    type.textContent = `Type: ${log.type}`;
    
    header.appendChild(eventId);
    header.appendChild(type);
    
    const message = document.createElement('div');
    message.className = 'log-message';
    message.textContent = log.message;

    if (log.timestamp) {
        const time = document.createElement('div');
        time.style.color = 'var(--secondary)';
        time.style.fontSize = '0.8rem';
        time.style.marginTop = '0.5rem';
        time.textContent = `Time: ${log.timestamp}`;
        message.appendChild(time);
    }

    entry.appendChild(header);
    entry.appendChild(message);
    
    return entry;
}

// Loading overlay control
const loading = {
    overlay: document.getElementById('loading-overlay'),
    text: document.getElementById('loading-overlay').querySelector('.loading-text'),
    show(message) {
        this.text.textContent = message;
        this.overlay.classList.add('active');
    },
    hide() {
        this.overlay.classList.remove('active');
    }
};

// Clear content except loading overlay
function clearContent() {
    const content = Array.from(logsOutput.children).filter(child => !child.classList.contains('loading-overlay'));
    content.forEach(child => child.remove());
}

// Show IPNS resolve result
function showResolveResult(resolvedCid) {
    const resolveResult = document.createElement('div');
    resolveResult.style.cssText = `
        padding: 1rem;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 6px;
        border: 1px solid var(--primary);
        margin-bottom: 1rem;
        font-family: 'Share Tech Mono', monospace;
    `;

    resolveResult.innerHTML = `
        <div style="color: #00ff00; margin-bottom: 0.5rem; font-size: 16px; font-weight: bold;">
            RESOLVED CID:
        </div>
        <div style="color: #a0a0a0; word-break: break-all; margin-bottom: 1rem;">
            ${resolvedCid}
        </div>
        <div style="display: flex; gap: 1rem;">
            <button class="secondary" id="copy-cid">
                <span class="copy-icon">📋</span>Copy CID
            </button>
            <button class="primary" id="fetch-resolved">
                <span style="margin-right: 4px;">🔍</span>Fetch Logs
            </button>
        </div>
    `;

    logsOutput.insertBefore(resolveResult, loading.overlay);

    // Add button handlers
    document.getElementById('copy-cid').onclick = () => {
        navigator.clipboard.writeText(resolvedCid).then(() => showStatus('CID copied to clipboard'));
    };

    document.getElementById('fetch-resolved').onclick = () => {
        cidInput.value = resolvedCid;
        fetchLogs(resolvedCid, false);
    };
}

// Show error message
function showError(error) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        color: var(--error);
        padding: 1rem;
        background: rgba(255, 0, 0, 0.1);
        border-radius: 6px;
        margin-bottom: 1rem;
    `;
    errorDiv.textContent = `Error: ${error.message}`;
    logsOutput.insertBefore(errorDiv, loading.overlay);
}

// Resolve IPNS name
async function resolveIpns() {
    if (isResolving) return;
    if (Date.now() < resolveCooldownUntil) {
        showStatus('Resolve is cooling down, please wait...', true);
        return;
    }
    isResolving = true;
    setFlowStep('resolve');
    setButtonLoading(resolveBtn, 'RESOLVING...', 'RESOLVE IPNS', true);
    // Clear output
    logsOutput.innerHTML = '';
    logsOutput.appendChild(loading.overlay);

    // Show loading
    loading.text.textContent = 'Resolving IPNS...';
    loading.show();

    try {
        // Make request
        const response = await fetch('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ipnsKey: cidInput.value.trim() || undefined })
        });

        // Hide loading
        loading.hide();

        // Handle errors
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Parse response
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || 'Failed to resolve IPNS');
        }

        // Get CID
        const resolvedCid = data.data;
        if (!resolvedCid) {
            throw new Error('Could not find CID in response');
        }

        // Show result
        latestResolvedCid = resolvedCid;
        loadDistribution(resolvedCid);
        const resultDiv = document.createElement('div');
        resultDiv.style.cssText = `
            padding: 1.5rem;
            background: rgba(13, 17, 23, 0.7);
            border-radius: 12px;
            border: 1px solid var(--primary);
            margin-bottom: 1.5rem;
            font-family: 'Share Tech Mono', monospace;
            color: white;
            position: relative;
            z-index: 1;
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        `;

        resultDiv.innerHTML = `
            <div style="margin-bottom: 1.5rem;">
                <div style="color: #00ff00; margin-bottom: 0.5rem; font-size: 18px; font-weight: bold; display: flex; align-items: center;">
                    <span style="margin-right: 8px;">🔗</span>RESOLVED CID
                </div>
                <div style="color: #a0a0a0; word-break: break-all; font-size: 15px; padding: 1rem; background: rgba(0,0,0,0.2); border-radius: 6px;">
                    ${resolvedCid}
                </div>
            </div>
            <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
                <button class="secondary" id="copy-cid" style="min-width: 120px;">
                    <span class="copy-icon" style="margin-right: 6px;">📋</span>Copy CID
                </button>
                <button class="primary" id="fetch-logs" style="min-width: 120px;">
                    <span style="margin-right: 6px;">📥</span>Fetch Logs
                </button>
            </div>
        `;

        logsOutput.appendChild(resultDiv);

        // Add button handlers
        document.getElementById('copy-cid').onclick = () => {
            navigator.clipboard.writeText(resolvedCid).then(() => {
                showStatus('CID copied to clipboard');
                // Copy animation
                const btn = document.getElementById('copy-cid');
                btn.style.transform = 'scale(0.95)';
                setTimeout(() => btn.style.transform = '', 100);
            });
        };

        document.getElementById('fetch-logs').onclick = () => {
            cidInput.value = resolvedCid;
            fetchLogs(resolvedCid);
        };

        if (data.stale) {
            showStatus(data.warning || 'IPNS timed out; using cached CID', true);
        } else {
            showStatus('IPNS resolved successfully');
        }
        setFlowStep('fetch');
    } catch (error) {
        // Hide loading
        loading.hide();

        // Show error
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            padding: 1.5rem;
            background: rgba(255, 0, 0, 0.05);
            border-radius: 12px;
            border: 1px solid var(--error);
            margin-bottom: 1.5rem;
            color: var(--error);
            position: relative;
            z-index: 1;
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        `;
        errorDiv.innerHTML = `
            <div style="font-size: 16px; display: flex; align-items: center;">
                <span style="font-size: 20px; margin-right: 8px;">⚠️</span>
                ${error.message}
            </div>
        `;
        logsOutput.appendChild(errorDiv);

        showStatus(error.message, true);
    } finally {
        isResolving = false;
        resolveCooldownUntil = Date.now() + 1500;
        setButtonLoading(resolveBtn, 'RESOLVING...', 'RESOLVE IPNS', false);
    }
}

// Fetch logs by CID
async function fetchLogs(cid) {
    if (isFetching) return;
    if (!cid) {
        cidInput.classList.add('error');
        showStatus('Please enter a CID', true);
        return;
    }
    isFetching = true;
    setFlowStep('fetch');
    setButtonLoading(fetchBtn, 'FETCHING...', 'FETCH LOGS', true);

    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = loadingOverlay.querySelector('.loading-text');
    const logsOutput = document.getElementById('logs-output');

    // We delete only the navigation elements and resolve the result, leaving the logs
    Array.from(logsOutput.children)
        .filter(node => {
            // Leaving the overlay and the log groups
            return node !== loadingOverlay && 
                   !node.classList.contains('logs-group') &&
                   !node.classList.contains('log-entry');
        })
        .forEach(node => node.remove());

    // Show loading
    loadingText.textContent = 'Fetching logs...';
    loadingOverlay.classList.add('active');

    try {
        const response = await fetch('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cid })
        });

        const data = await response.json();

        // Hide loading
        loadingOverlay.classList.remove('active');
        if (!data.success) {
            throw new Error(data.error || 'Failed to fetch logs');
        }

        // Display logs in reverse order
        if (data.data && Array.isArray(data.data.logs)) {
            latestFetchedLogs = [...data.data.logs];
            latestPrevCid = data.data.prev_cid || '';
            if (!latestResolvedCid) latestResolvedCid = cid;
            loadDistribution(latestResolvedCid);
            renderFetchedLogs();
        }

        showStatus('Logs fetched successfully');
        setFlowStep('show');
    } catch (error) {
        // Hide loading
        loadingOverlay.classList.remove('active');

        // Show error
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            color: var(--error);
            padding: 1rem;
            background: rgba(255, 0, 0, 0.1);
            border-radius: 6px;
            margin-bottom: 1rem;
        `;
        errorDiv.textContent = `Error: ${error.message}`;
        logsOutput.insertBefore(errorDiv, loadingOverlay);

        showStatus(error.message, true);
    } finally {
        isFetching = false;
        setButtonLoading(fetchBtn, 'FETCHING...', 'FETCH LOGS', false);
    }
}

async function loadKeys() {
    try {
        const response = await fetch('/api/keys');
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to load keys');
        }

        keysList.innerHTML = '';
        data.keys.forEach(keyString => {
            const parts = keyString.trim().split(/\s+/);
            const name = parts.length > 1 ? parts[parts.length - 1] : 'unnamed';
            const value = parts.length > 1 ? parts.slice(0, -1).join(' ') : keyString.trim();
            
            const keyItem = document.createElement('div');
            keyItem.className = 'key-item';
            
            const keyInfo = document.createElement('div');
            keyInfo.className = 'key-info';
            
            // Show key name in large green font
            const keyName = document.createElement('div');
            keyName.className = 'key-name';
            keyName.style.fontSize = '16px';
            keyName.style.fontWeight = 'bold';
            keyName.style.color = '#00ff00';
            keyName.style.marginBottom = '8px';
            keyName.style.letterSpacing = '1px';
            keyName.textContent = name;
            
            // Then show key value in monospace font
            const keyValue = document.createElement('div');
            keyValue.className = 'key-value';
            keyValue.style.fontSize = '13px';
            keyValue.style.fontFamily = 'Share Tech Mono, monospace';
            keyValue.style.wordBreak = 'break-all';
            keyValue.style.color = '#a0a0a0';
            keyValue.style.lineHeight = '1.4';
            keyValue.style.padding = '8px';
            keyValue.style.background = 'rgba(0, 0, 0, 0.2)';
            keyValue.style.borderRadius = '4px';
            keyValue.style.border = '1px solid rgba(0, 255, 0, 0.1)';
            keyValue.textContent = value;
            
            keyInfo.appendChild(keyName);
            keyInfo.appendChild(keyValue);
            
            const copyBtn = document.createElement('button');
            copyBtn.className = 'secondary';
            copyBtn.style.width = 'auto';
            copyBtn.style.marginLeft = '12px';
            copyBtn.style.alignSelf = 'center';
            copyBtn.innerHTML = '<span class="copy-icon">📋</span>Copy';
            copyBtn.onclick = () => {
                // Always copy key value
                navigator.clipboard.writeText(value);
                
                // Copy success animation
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = '<span class="copy-icon">✓</span>Copied!';
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = '<span class="copy-icon">📋</span>Copy';
                }, 1500);
                
                showStatus('Key copied to clipboard');
            };
            
            keyItem.appendChild(keyInfo);
            keyItem.appendChild(copyBtn);
            keysList.appendChild(keyItem);
        });
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function generateKey(name) {
    try {
        const response = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to generate key');
        }

        showStatus('Key generated successfully');
        loadKeys();
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function saveConfig() {
    try {
        const config = {};
        
        function processInputs(container) {
            container.querySelectorAll('input, select').forEach(input => {
                if (!input.dataset.path) return;
                
                const path = input.dataset.path;
                let value = input.value;
                
                // Convert value types
                if (input.type === 'number') {
                    value = Number(value);
                } else if (input.type === 'checkbox') {
                    value = input.checked;
                } else if (value === 'true' || value === 'false') {
                    value = value === 'true';
                } else if (!isNaN(value) && value.trim() !== '' && !path.includes('host') && !path.includes('path') && !path.includes('dir') && !path.includes('file')) {
                    value = Number(value);
                }
                
                // Handle array paths like "section.key[0]"
                if (path.includes('[')) {
                    const match = path.match(/(.*?)\[(\d+)\]$/);
                    if (match) {
                        const [_, arrayPath, index] = match;
                        const parts = arrayPath.split('.');
                        let current = config;
                        
                        // Create path to array
                        for (let i = 0; i < parts.length - 1; i++) {
                            if (!current[parts[i]]) current[parts[i]] = {};
                            current = current[parts[i]];
                        }
                        
                        // Create array if doesn't exist
                        const lastPart = parts[parts.length - 1];
                        if (!current[lastPart]) current[lastPart] = [];
                        
                        // Set array value
                        current[lastPart][Number(index)] = value;
                        return;
                    }
                }
                
                // Handle regular paths
                const parts = path.split('.');
                let current = config;
                
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!current[parts[i]]) current[parts[i]] = {};
                    current = current[parts[i]];
                }
                
                // Special handling for known boolean fields
                const booleanFields = [
                    'allow_offline',
                    'allow_online',
                    'pin_enabled',
                    'pin_recursive',
                    'enable_console',
                    'enable_file',
                    'include_source',
                    'source_location',
                    'enable_key_rotation',
                    'backup_enabled',
                    'proxy_enabled',
                    'ssl_enabled',
                    'auth_enabled'
                ];
                
                const lastPart = parts[parts.length - 1];
                if (booleanFields.includes(lastPart)) {
                    value = value === 'true' || value === true;
                }
                
                current[parts[parts.length - 1]] = value;
            });
        }
        
        processInputs(configEditor);

        // Show saving indicator
        showStatus('Saving configuration...');

        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to save configuration');
        }

        // Reload config to show updated values
        await loadConfig();
        showStatus('Configuration saved successfully');
    } catch (error) {
        console.error('Save config error:', error);
        showStatus(error.message, true);
        
        // Mark invalid fields
        const invalidFields = document.querySelectorAll('input:invalid, select:invalid');
        invalidFields.forEach(field => {
            field.classList.add('error');
            field.addEventListener('input', function() {
                this.classList.remove('error');
            }, { once: true });
        });
    }
}

// Add validation to config fields
function addConfigValidation(input, section, key) {
    // Add required attribute to essential fields
    if (section === 'network' && ['default_port', 'default_host'].includes(key)) {
        input.required = true;
    }
    if (section === 'ipfs' && ['api_url', 'gateway_url'].includes(key)) {
        input.required = true;
    }
    if (section === 'encryption' && ['private_key_file', 'ipns_key_file'].includes(key)) {
        input.required = true;
    }
    if (section === 'logging' && key === 'log_file') {
        input.required = true;
    }

    // Add type validation
    if (section === 'network' && key === 'default_port') {
        input.type = 'number';
        input.min = 1;
        input.max = 65535;
    }
    if (key.includes('url')) {
        input.pattern = '^https?://.*';
        input.title = 'Must be a valid URL starting with http:// or https://';
    }
    if (key.includes('file')) {
        input.pattern = '^[\\w\\-./]+$';
        input.title = 'Must be a valid file path';
    }
    if (section === 'ipfs' && key === 'key_gen_bits') {
        input.type = 'number';
        input.min = 1024;
        input.max = 4096;
        input.step = 1024;
        input.title = 'Must be between 1024 and 4096 bits';
    }
    if (section === 'ipfs' && key === 'name_resolve_timeout') {
        input.pattern = '^\\d+[smh]$';
        input.title = 'Must be a number followed by s (seconds), m (minutes), or h (hours)';
    }
}

// Updating configuration descriptions
const configDescriptions = {
    network: {
        title: 'Network Settings',
        description: 'Configure network connectivity and timeouts',
        fields: {
            default_host: 'Default host address for network connections',
            default_port: 'Default port number for network services',
            connection_timeout: 'Maximum time to wait for network connections (milliseconds)',
            max_retries: 'Maximum number of retry attempts for failed operations',
            keep_alive: 'Keep network connections alive for better performance',
            process_kill_timeout: 'Time to wait before forcefully killing processes (milliseconds)',
            cleanup_wait_timeout: 'Time to wait for cleanup operations (milliseconds)',
            daemon_shutdown_timeout: 'Time to wait for daemon shutdown (milliseconds)',
            stats_update_interval: 'Interval for updating network statistics (milliseconds)',
            ping_timeout: 'Maximum time to wait for ping responses (milliseconds)',
            interface_speed_detection: 'Settings for detecting network interface speeds'
        }
    },
    server: {
        title: 'Server Settings',
        description: 'Web server configuration',
        fields: {
            port: 'Server listening port',
            host: 'Server listening address',
            static_dir: 'Directory for static files',
            api_prefix: 'Prefix for API endpoints',
            cors: 'Cross-Origin Resource Sharing settings',
            rate_limit: 'Rate limiting configuration for API endpoints'
        }
    },
    ipfs: {
        title: 'IPFS Settings',
        description: 'IPFS node and gateway configuration',
        fields: {
            api_url: 'IPFS API endpoint URL',
            gateway_url: 'IPFS Gateway URL for content access',
            timeout: 'IPFS operation timeout (milliseconds)',
            max_retries: 'Maximum retry attempts for IPFS operations',
            allow_offline: 'Allow operations in offline mode',
            allow_online: 'Allow operations in online mode',
            pin_enabled: 'Enable content pinning',
            pin_recursive: 'Enable recursive pinning of content',
            name_resolve_timeout: 'IPNS name resolution timeout',
            last_file_path: 'Path to last processed file',
            pid_file: 'Path to PID file',
            daemon_startup_timeout: 'Time to wait for daemon startup',
            custom_args: 'Additional arguments for IPFS daemon',
            repo_dir: 'IPFS repository directory path',
            key_gen_bits: 'Key size for key generation (bits)'
        }
    },
    encryption: {
        title: 'Encryption Settings',
        description: 'Encryption and key management',
        fields: {
            default_cipher: 'Default encryption algorithm',
            key_size: 'Encryption key size in bits',
            iv_size: 'Initialization vector size',
            tag_size: 'Authentication tag size',
            private_key_file: 'Path to private key file',
            ipns_key_file: 'Path to IPNS key file',
            key_derivation: 'Key derivation function',
            pbkdf2_iterations: 'Number of PBKDF2 iterations',
            pbkdf2_digest: 'PBKDF2 hash algorithm',
            enable_key_rotation: 'Enable automatic key rotation',
            key_rotation_interval: 'Interval for key rotation',
            backup_enabled: 'Enable key backup',
            backup_path: 'Directory for key backups',
            oaep_hash: 'Hash algorithm for OAEP padding',
            padding_scheme: 'Encryption padding scheme',
            encoding: 'Key encoding format',
            key_format: 'Key file format'
        }
    },
    logging: {
        title: 'Logging Settings',
        description: 'Logging and monitoring configuration',
        fields: {
            log_file: 'Path to main log file',
            log_level: 'Default logging level',
            max_log_size: 'Maximum size of log files',
            max_log_files: 'Maximum number of log files to keep',
            enable_console: 'Enable console logging',
            enable_file: 'Enable file logging',
            format: 'Log format (json/text)',
            timestamp_format: 'Format for log timestamps',
            include_source: 'Include source information in logs',
            source_location: 'Include source code location',
            log_dir: 'Directory for log files',
            output_file: 'Output file name pattern',
            indent: 'JSON indentation level',
            sort_field: 'Field to sort logs by',
            sort_order: 'Log sorting order',
            error_handling: 'Error handling configuration',
            log_rotation: 'Log rotation settings',
            categories: 'Log categories configuration',
            console_format: 'Console output format',
            file_format: 'File output format',
            stats_file: 'Path to statistics file'
        }
    },
    security: {
        title: 'Security Settings',
        description: 'Security and access control',
        fields: {
            rate_limiting: 'Rate limiting configuration',
            cors: 'CORS policy settings',
            api_keys: 'API key management settings',
            ip_whitelist: 'IP address whitelist configuration',
            proxy_enabled: 'Enable proxy support',
            proxy_url: 'Proxy server URL',
            auth_enabled: 'Enable authentication',
            auth_type: 'Authentication type',
            session_timeout: 'Session timeout period',
            max_sessions: 'Maximum concurrent sessions',
            password_policy: 'Password policy settings',
            ssl_enabled: 'Enable SSL/TLS',
            ssl_cert: 'Path to SSL certificate',
            ssl_key: 'Path to SSL private key'
        }
    },
    performance: {
        title: 'Performance Settings',
        description: 'Performance optimization settings',
        fields: {
            cache: 'Cache configuration',
            compression: 'Response compression settings',
            batch_processing: 'Batch processing settings',
            max_concurrent: 'Maximum concurrent operations',
            thread_pool: 'Thread pool configuration',
            buffer_size: 'Buffer size for operations',
            queue_size: 'Operation queue size',
            prefetch: 'Prefetch settings',
            optimization_level: 'Code optimization level',
            gc_interval: 'Garbage collection interval'
        }
    }
};

// Updating the function of creating the configuration editor
function createConfigEditor(config) {
    configEditor.innerHTML = '';
    const sections = Object.entries(config);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; gap:0.8rem; margin-bottom:1rem;';

    const expandAllBtn = document.createElement('button');
    expandAllBtn.className = 'secondary';
    expandAllBtn.style.width = 'auto';
    expandAllBtn.textContent = 'Expand All';
    expandAllBtn.addEventListener('click', () => {
        configEditor.querySelectorAll('.config-section').forEach(sectionEl => {
            const sectionContent = sectionEl.querySelector('.config-section-content');
            if (sectionContent) sectionContent.style.display = 'block';
            const icon = sectionEl.querySelector('.collapse-icon');
            if (icon) icon.textContent = 'Hide';
        });
    });

    const collapseAllBtn = document.createElement('button');
    collapseAllBtn.className = 'secondary';
    collapseAllBtn.style.width = 'auto';
    collapseAllBtn.textContent = 'Collapse All';
    collapseAllBtn.addEventListener('click', () => {
        configEditor.querySelectorAll('.config-section').forEach(sectionEl => {
            const sectionContent = sectionEl.querySelector('.config-section-content');
            if (sectionContent) sectionContent.style.display = 'none';
            const icon = sectionEl.querySelector('.collapse-icon');
            if (icon) icon.textContent = 'Show';
        });
    });

    controls.appendChild(expandAllBtn);
    controls.appendChild(collapseAllBtn);
    configEditor.appendChild(controls);
    
    sections.forEach(([section, settings]) => {
        const sectionDiv = document.createElement('div');
        sectionDiv.className = 'config-section';
        sectionDiv.dataset.section = section;
        
        const header = document.createElement('div');
        header.className = 'config-section-header';
        header.style.cursor = 'pointer';
        
        const titleGroup = document.createElement('div');
        titleGroup.className = 'title-group';
        
        const title = document.createElement('div');
        title.className = 'panel-title';
        title.textContent = configDescriptions[section]?.title || section;
        
        const desc = document.createElement('div');
        desc.className = 'panel-description';
        desc.textContent = configDescriptions[section]?.description || '';
        
        titleGroup.appendChild(title);
        titleGroup.appendChild(desc);
        
        const collapseIcon = document.createElement('button');
        collapseIcon.type = 'button';
        collapseIcon.className = 'collapse-icon';
        collapseIcon.textContent = 'Hide';
        
        header.appendChild(titleGroup);
        header.appendChild(collapseIcon);
        
        const content = document.createElement('div');
        content.className = 'config-section-content';
        content.style.display = 'block';
        
        const table = document.createElement('table');
        table.className = 'config-table';
        
        function createInput(key, value, path = '') {
            const fullPath = path ? `${path}.${key}` : key;
            const description = configDescriptions[path]?.fields[key] || '';
            
            if (value === null || value === undefined) {
                const input = document.createElement('input');
                input.type = 'text';
                input.value = '';
                input.placeholder = 'Not set';
                input.dataset.path = fullPath;
                input.title = description;
                return input;
            }
            
            // List of known boolean fields
            const booleanFields = [
                'allow_offline',
                'allow_online',
                'pin_enabled',
                'pin_recursive',
                'enable_console',
                'enable_file',
                'include_source',
                'source_location',
                'enable_key_rotation',
                'backup_enabled',
                'proxy_enabled',
                'ssl_enabled',
                'auth_enabled'
            ];
            
            if (Array.isArray(value)) {
                const container = document.createElement('div');
                container.className = 'config-array-container';
                
                value.forEach((item, index) => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'config-array-item';
                    
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = item;
                    input.dataset.path = `${fullPath}[${index}]`;
                    input.title = description;
                    
                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = '×';
                    removeBtn.className = 'secondary';
                    removeBtn.onclick = () => itemDiv.remove();
                    
                    itemDiv.appendChild(input);
                    itemDiv.appendChild(removeBtn);
                    container.appendChild(itemDiv);
                });
                
                const addBtn = document.createElement('button');
                addBtn.textContent = '+ Add Item';
                addBtn.className = 'secondary';
                addBtn.onclick = () => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'config-array-item';
                    
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.dataset.path = `${fullPath}[${container.children.length}]`;
                    input.title = description;
                    
                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = '×';
                    removeBtn.className = 'secondary';
                    removeBtn.onclick = () => itemDiv.remove();
                    
                    itemDiv.appendChild(input);
                    itemDiv.appendChild(removeBtn);
                    container.insertBefore(itemDiv, addBtn);
                };
                
                container.appendChild(addBtn);
                return container;
            }
            
            if (typeof value === 'object') {
                const container = document.createElement('div');
                container.className = 'config-nested';
                
                Object.entries(value).forEach(([subKey, subValue]) => {
                    const row = document.createElement('div');
                    row.style.marginBottom = '1rem';
                    
                    const label = document.createElement('div');
                    label.className = 'config-nested-label';
                    label.textContent = subKey;
                    label.title = configDescriptions[fullPath]?.fields[subKey] || '';
                    
                    row.appendChild(label);
                    row.appendChild(createInput(subKey, subValue, fullPath));
                    container.appendChild(row);
                });
                
                return container;
            }
            
            if (typeof value === 'boolean' || booleanFields.includes(key)) {
                const container = document.createElement('div');
                container.style.display = 'flex';
                container.style.alignItems = 'center';
                container.style.gap = '8px';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = value === true || value === 'true';
                checkbox.dataset.path = fullPath;
                checkbox.title = description;
                checkbox.style.appearance = 'none';
                checkbox.style.width = '20px';
                checkbox.style.height = '20px';
                checkbox.style.border = '2px solid #00ff00';
                checkbox.style.borderRadius = '4px';
                checkbox.style.backgroundColor = 'transparent';
                checkbox.style.position = 'relative';
                checkbox.style.cursor = 'pointer';
                checkbox.style.transition = 'all 0.2s ease';
                checkbox.classList.add('config-checkbox');

                const label = document.createElement('span');
                label.textContent = checkbox.checked ? 'Enabled' : 'Disabled';
                label.style.color = checkbox.checked ? '#00ff00' : '#a0a0a0';
                label.style.userSelect = 'none';
                label.style.cursor = 'pointer';

                checkbox.addEventListener('change', () => {
                    label.textContent = checkbox.checked ? 'Enabled' : 'Disabled';
                    label.style.color = checkbox.checked ? '#00ff00' : '#a0a0a0';
                });

                label.addEventListener('click', () => {
                    checkbox.click();
                });

                container.appendChild(checkbox);
                container.appendChild(label);
                return container;
            }
            
            if (typeof value === 'number') {
                const input = document.createElement('input');
                input.type = 'number';
                input.value = value;
                input.dataset.path = fullPath;
                input.title = description;
                return input;
            }
            
            const input = document.createElement('input');
            input.type = 'text';
            input.value = value;
            input.dataset.path = fullPath;
            input.title = description;
            return input;
        }
        
        Object.entries(settings).forEach(([key, value]) => {
            const row = document.createElement('tr');
            
            const keyCell = document.createElement('th');
            keyCell.textContent = key;
            
            const descCell = document.createElement('td');
            descCell.className = 'description';
            descCell.textContent = configDescriptions[section]?.fields[key] || '';
            
            const valueCell = document.createElement('td');
            valueCell.className = 'value';
            
            const input = createInput(key, value, section);
            valueCell.appendChild(input);
            
            row.appendChild(keyCell);
            row.appendChild(descCell);
            row.appendChild(valueCell);
            table.appendChild(row);
        });
        
        content.appendChild(table);
        
        const toggleSection = () => {
            const isHidden = content.style.display === 'none';
            content.style.display = isHidden ? 'block' : 'none';
            collapseIcon.textContent = isHidden ? 'Hide' : 'Show';
        };

        header.addEventListener('click', toggleSection);
        collapseIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSection();
        });
        
        sectionDiv.appendChild(header);
        sectionDiv.appendChild(content);
        configEditor.appendChild(sectionDiv);
    });
}

async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to load configuration');
        }

        createConfigEditor(data.config);
    } catch (error) {
        showStatus(error.message, true);
    }
}

async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to load stats');
        }

        systemStats.innerHTML = '';
        
        // System Uptime
        const uptimeCard = document.createElement('div');
        uptimeCard.className = 'stat-card';
        uptimeCard.innerHTML = `
            <div class="stat-title">System Uptime</div>
            <div class="stat-value">${data.stats.system.uptimeFormatted}</div>
            <div class="stat-details">
                Process: ${data.stats.process.uptimeFormatted}
            </div>
        `;
        
        // Process Memory usage
        const memory = data.stats.process.memory;
        const totalMemory = Math.round(data.stats.system.totalMemory / 1024); // Convert to GB
        const memoryCard = document.createElement('div');
        memoryCard.className = 'stat-card';
        memoryCard.innerHTML = `
            <div class="stat-title">Process Memory</div>
            <div class="stat-value">
                ${memory.rss}MB
                <span class="stat-percentage ${memory.percentage > 1 ? 'warning' : ''}">${memory.percentage}% of ${totalMemory}GB</span>
            </div>
            <div class="stat-progress">
                <div class="progress-bar ${memory.percentage > 1 ? 'warning' : ''}" style="width: ${Math.min(memory.percentage * 2, 100)}%"></div>
            </div>
        `;
        
        // Process CPU Usage
        const cpu = data.stats.process.cpu;
        const loadCard = document.createElement('div');
        loadCard.className = 'stat-card';
        loadCard.innerHTML = `
            <div class="stat-title">Process CPU Usage</div>
            <div class="stat-value">
                ${cpu.percentage}%
                <span class="stat-percentage">(${cpu.cores} cores)</span>
            </div>
            <div class="stat-progress">
                <div class="progress-bar ${cpu.percentage > 50 ? 'warning' : ''}" style="width: ${cpu.percentage}%"></div>
            </div>
        `;

        // Network Interfaces
        const network = data.stats.network;
        const networkCard = document.createElement('div');
        networkCard.className = 'stat-card';
        
        let networkHtml = '<div class="stat-title">Network Interfaces</div>';

        // Load saved max speeds
        let savedMaxSpeeds = {};
        try {
            const saved = localStorage.getItem('network_max_speeds');
            if (saved) {
                savedMaxSpeeds = JSON.parse(saved);
            }
        } catch (e) {
            console.error('Error loading saved speeds:', e);
        }

        for (const [name, stats] of Object.entries(network)) {
            let speedHtml = '';
            let connectionType = '';
            let connectionQuality = '';
            
            // Determine connection type
            if (name.startsWith('en')) {
                if (name.includes('wl')) {
                    connectionType = 'Wi-Fi';
                } else {
                    connectionType = 'Ethernet';
                }
            } else if (name.startsWith('wl')) {
                connectionType = 'Wi-Fi';
            }

            if (stats.rxSpeed !== undefined && stats.txSpeed !== undefined) {
                // Check for saved max speeds for this interface
                if (!savedMaxSpeeds[name]) {
                    savedMaxSpeeds[name] = { rx: 0, tx: 0 };
                }

                // Update max speeds
                if (stats.rxSpeed > savedMaxSpeeds[name].rx) {
                    savedMaxSpeeds[name].rx = stats.rxSpeed;
                }
                if (stats.txSpeed > savedMaxSpeeds[name].tx) {
                    savedMaxSpeeds[name].tx = stats.txSpeed;
                }

                speedHtml = `
                    <div class="network-speeds">
                        <span class="speed-item">
                            ↓ ${formatNetworkSpeed(stats.rxSpeed)} MB/s
                            <span class="max-speed">(max: ${formatNetworkSpeed(savedMaxSpeeds[name].rx)} MB/s)</span>
                        </span>
                        <span class="speed-item">
                            ↑ ${formatNetworkSpeed(stats.txSpeed)} MB/s
                            <span class="max-speed">(max: ${formatNetworkSpeed(savedMaxSpeeds[name].tx)} MB/s)</span>
                        </span>
                    </div>
                `;
            }
            
            networkHtml += `
                <div class="network-interface">
                    <div class="interface-header">
                        <span class="interface-name">${name}</span>
                        <span class="connection-type">${connectionType}</span>
                        ${connectionQuality}
                    </div>
                    <div class="interface-details">
                        <div class="ip-address">${stats.address || 'No IP'}</div>
                        ${speedHtml}
                    </div>
                </div>
            `;
        }

        // Save updated max speeds
        try {
            localStorage.setItem('network_max_speeds', JSON.stringify(savedMaxSpeeds));
        } catch (e) {
            console.error('Error saving network stats:', e);
        }
        
        networkCard.innerHTML = networkHtml;
        
        systemStats.appendChild(uptimeCard);
        systemStats.appendChild(memoryCard);
        systemStats.appendChild(loadCard);
        systemStats.appendChild(networkCard);

        return true; // Indicate successful load
    } catch (error) {
        console.error('Failed to load stats:', error);
        systemStats.innerHTML = `
            <div class="stat-card" style="border-color: var(--error);">
                <div class="stat-title" style="color: var(--error);">Error Loading Stats</div>
                <div class="stat-value" style="color: var(--error);">${error.message}</div>
            </div>
        `;
        throw error; // Re-throw to be caught by initStats
    }
}

function formatBytes(bytes, forceUnit = null) {
    if (bytes === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = forceUnit !== null ? 
        sizes.indexOf(forceUnit) : 
        Math.floor(Math.log(bytes) / Math.log(k));
    
    i = Math.max(0, Math.min(i, sizes.length - 1));
    const value = bytes / Math.pow(k, i);
    
    // For small values, use more decimal places
    const decimals = value < 1 ? 2 : 1;
    return `${value.toFixed(decimals)} ${sizes[i]}`;
}

function formatBits(bits) {
    if (bits === 0) return '0 Mbps';
    return `${bits} Mbps`;
}

function formatNetworkSpeed(bytes, forceUnit = 'MB/s') {
    if (bytes === 0) return '0.00';
    
    const k = 1024;
    const units = {
        'B/s': 1,
        'KB/s': k,
        'MB/s': k * k
    };

    const value = bytes / units[forceUnit];
    return value.toFixed(2);
}

function determineNetworkActivity(rxSpeed, txSpeed, savedMaxRx, savedMaxTx) {
    // Network activity threshold (bytes per second)
    const ACTIVITY_THRESHOLD = 1024; // 1 KB/s

    const isRxActive = rxSpeed > ACTIVITY_THRESHOLD;
    const isTxActive = txSpeed > ACTIVITY_THRESHOLD;

    return {
        isActive: isRxActive || isTxActive,
        rxActive: isRxActive,
        txActive: isTxActive,
        currentRx: formatNetworkSpeed(rxSpeed),
        currentTx: formatNetworkSpeed(txSpeed),
        maxRx: formatNetworkSpeed(savedMaxRx),
        maxTx: formatNetworkSpeed(savedMaxTx)
    };
}

function determineNetworkQuality(rxSpeed, txSpeed) {
    // Return empty string
    return '';
}

// Log viewer functionality
const logViewer = document.getElementById('log-viewer');
const logViewerHeader = document.getElementById('log-viewer-header');
const logViewerContent = document.getElementById('log-viewer-content');
const logCount = document.getElementById('log-count');
const showErrors = document.getElementById('show-errors');
const showWarnings = document.getElementById('show-warnings');
const showInfo = document.getElementById('show-info');
const clearLogBtn = document.getElementById('clear-log-btn');
const exportLogBtn = document.getElementById('export-log-btn');
const logSearch = document.getElementById('log-search');

let logs = [];
let isLoadingLogs = false;
let apiHealthy = true;
let apiHealthRetryTimer = null;

// Update log visibility based on filters
function updateLogVisibility() {
    const searchTerm = logSearch?.value.toLowerCase() || '';
    
    // Get all log entries
    const entries = Array.from(logViewerContent.children);
    let visibleCount = 0;
    
    entries.forEach(entry => {
        if (entry.classList.contains('loading-overlay')) return;
        
        // Check level visibility
        const isError = entry.querySelector('.log-level.error');
        const isWarn = entry.querySelector('.log-level.warn');
        const isInfo = entry.querySelector('.log-level.info');
        
        let shouldShow = (isError && showErrors.checked) ||
                        (isWarn && showWarnings.checked) ||
                        (isInfo && showInfo.checked);
        
        // Apply search filter
        if (shouldShow && searchTerm) {
            const content = entry.textContent.toLowerCase();
            shouldShow = content.includes(searchTerm);
        }
        
        // Update visibility
        entry.style.display = shouldShow ? 'block' : 'none';
        if (shouldShow) visibleCount++;
    });
    
    // Update counter
    logCount.textContent = `(${visibleCount})`;
}

// Load system logs
async function loadSystemLogs() {
    if (isLoadingLogs) return;
    isLoadingLogs = true;
    
    try {
        const response = await fetch('/api/logs');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        if (data.success && Array.isArray(data.logs)) {
            const filteredLogs = data.logs
                .filter((log) => {
                    const source = log.meta?.source || 'system';
                    const msg = (log.message || '').toLowerCase();
                    // Avoid UI noise from repetitive system telemetry/errors not useful for demos.
                    if (source === 'system' && (
                        msg.includes('error detecting speed for') ||
                        msg.includes('error reading linux network stats') ||
                        msg.includes('error reading macos network stats') ||
                        msg.includes('error getting stats for')
                    )) {
                        return false;
                    }
                    return true;
                })
                .slice(0, 200);

            // Сортируем логи по времени (новые сверху) и добавляем только новые
            const sortedLogs = [...filteredLogs].sort((a, b) => 
                new Date(b.timestamp) - new Date(a.timestamp)
            );
            sortedLogs.forEach(log => {
                const level = log.level?.toLowerCase() || 'info';
                // Check if log already exists
                const exists = Array.from(logViewerContent.children).some(entry => {
                    return entry.dataset.timestamp === log.timestamp && 
                           entry.dataset.message === log.message;
                });
                
                if (!exists) {
                    const entry = document.createElement('div');
                    entry.className = `log-entry ${level}`;
                    entry.dataset.timestamp = log.timestamp;
                    entry.dataset.message = log.message;
                    
                    const header = document.createElement('div');
                    header.className = 'log-entry-header';
                    
                    const timestamp = document.createElement('span');
                    timestamp.className = 'log-timestamp';
                    timestamp.textContent = new Date(log.timestamp).toLocaleString();
                    
                    const levelEl = document.createElement('span');
                    levelEl.className = `log-level ${level}`;
                    levelEl.textContent = level.toUpperCase();
                    
                    const source = document.createElement('span');
                    source.className = 'log-source';
                    source.textContent = log.meta?.source || 'system';
                    
                    header.appendChild(timestamp);
                    header.appendChild(levelEl);
                    header.appendChild(source);
                    
                    const message = document.createElement('div');
                    message.className = 'log-message';
                    message.textContent = log.message;
                    
                    entry.appendChild(header);
                    entry.appendChild(message);
                    
                    if (log.meta && Object.keys(log.meta).length > 0) {
                        const { source: _, ...metaWithoutSource } = log.meta;
                        if (Object.keys(metaWithoutSource).length > 0) {
                            const meta = document.createElement('pre');
                            meta.className = 'log-meta';
                            meta.textContent = JSON.stringify(metaWithoutSource, null, 2);
                            entry.appendChild(meta);
                        }
                    }
                    
                    // Всегда добавляем новые логи в начало
                    logViewerContent.insertBefore(entry, logViewerContent.firstChild);
                }
            });
            
            // Update log visibility
            updateLogVisibility();
        }
    } catch (error) {
        console.error('Failed to load system logs:', error);
    } finally {
        isLoadingLogs = false;
    }
}

// Load logs initially and periodically
loadSystemLogs();
const logInterval = setInterval(loadSystemLogs, 5000);

// Clean up interval on page unload
window.addEventListener('unload', () => {
    clearInterval(logInterval);
});

// Toggle log viewer
logViewerHeader.addEventListener('click', () => {
    logViewer.classList.toggle('collapsed');
});

// Write log to server
async function writeLog(level, message, meta = {}) {
    if (!apiHealthy) return;
    const maxRetries = 3;
    let retryCount = 0;
    let lastError = null;

    while (retryCount < maxRetries) {
        try {
            const response = await fetch('/api/logs', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    level,
                    message,
                    meta: {
                        source: 'web',
                        ...meta
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Success - exit retry loop
            return;
        } catch (error) {
            lastError = error;
            retryCount++;
            
            if (retryCount < maxRetries) {
                // Wait before retrying (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 100));
            }
        }
    }

    // If we get here, all retries failed
    // IMPORTANT: don't use console.error here because we override console.* below
    // and that can create an infinite recursion loop when the API is unreachable.
    try {
        const fallbackErr = globalThis.__nexusOriginalConsole?.error || globalThis.console?.error;
        if (typeof fallbackErr === 'function') fallbackErr('Failed to write log after retries:', lastError);
    } catch (_) {}

    // Mark API unhealthy to stop spamming requests; retry later.
    apiHealthy = false;
    if (!apiHealthRetryTimer) {
        apiHealthRetryTimer = setTimeout(() => {
            apiHealthy = true;
            apiHealthRetryTimer = null;
        }, 10_000);
    }
    
    // Store failed log locally
    const failedLog = {
        timestamp: new Date().toISOString(),
        level,
        message,
        meta: {
            source: 'web',
            error: lastError.message,
            ...meta
        }
    };

    // Store in localStorage for potential recovery
    try {
        const failedLogs = JSON.parse(localStorage.getItem('failedLogs') || '[]');
        failedLogs.push(failedLog);
        localStorage.setItem('failedLogs', JSON.stringify(failedLogs));
    } catch (e) {
        console.error('Failed to store failed log:', e);
    }
}

// Add log entry
function addLog(level, message, meta = {}, timestamp = null, shouldWrite = true) {
    // Validate level
    if (!['error', 'warn', 'info'].includes(level)) {
        level = 'info';
    }

    const log = {
        timestamp: timestamp || new Date().toISOString(),
        level,
        message,
        meta
    };
    
    // Check if log already exists
    const exists = logs.some(l => 
        l.timestamp === log.timestamp && 
        l.message === log.message &&
        l.level === log.level
    );
    
    if (!exists) {
        logs.push(log);
        // Sort logs by timestamp, newest first
        logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        // Keep only last 1000 logs
        if (logs.length > 1000) {
            logs = logs.slice(0, 1000);
        }
        
        // Write new log to server
        if (shouldWrite && meta.source !== 'system') {
            writeLog(level, message, meta);
        }
    }
}

// Override console methods to capture logs
const originalConsole = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    log: console.log
};

// Expose for safe logging when console is overridden.
globalThis.__nexusOriginalConsole = originalConsole;

console.error = (...args) => {
    originalConsole.error.apply(console, args);
    if (apiHealthy) writeLog('error', args.join(' '));
};

console.warn = (...args) => {
    originalConsole.warn.apply(console, args);
    if (apiHealthy) writeLog('warn', args.join(' '));
};

console.info = (...args) => {
    originalConsole.info.apply(console, args);
    // Intentionally do not mirror info logs to server to avoid UI log noise.
};

console.log = (...args) => {
    originalConsole.log.apply(console, args);
    // Intentionally do not mirror generic logs to server to avoid UI log noise.
};

// Handle uncaught errors
window.addEventListener('error', (event) => {
    writeLog('error', `Uncaught error: ${event.message}`, {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error?.stack
    });
});

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
    writeLog('error', `Unhandled promise rejection: ${event.reason}`, {
        stack: event.reason?.stack
    });
});

// Initial log
writeLog('info', 'Web interface started');

cidInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        fetchBtn.click();
    }
});

// Add search functionality
logSearch.addEventListener('input', updateLogVisibility);

// Add checkbox event listeners
[showErrors, showWarnings, showInfo].forEach(checkbox => {
    checkbox.addEventListener('change', updateLogVisibility);
});

// Clear logs functionality
async function clearLogs() {
    try {
        const response = await fetch('/api/logs/clear', {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Clear both log containers
        logViewerContent.innerHTML = '';
        logsOutput.innerHTML = '';
        
        // Clear logs array
        logs = [];
        
        // Update counter
        logCount.textContent = '(0)';
        
        showStatus('Logs cleared');
    } catch (error) {
        console.error('Failed to clear logs:', error);
        showStatus(error.message, true);
    }
}

// Add event listeners for both clear buttons
clearLogBtn.addEventListener('click', clearLogs);

// Export logs button handler
exportLogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    // Get all log entries from the viewer
    const logsToExport = Array.from(logViewerContent.children)
        .filter(entry => !entry.classList.contains('loading-overlay'))
        .map(entry => {
            const timestamp = entry.querySelector('.log-timestamp')?.textContent || '';
            const level = entry.querySelector('.log-level')?.textContent || 'INFO';
            const source = entry.querySelector('.log-source')?.textContent || 'system';
            const message = entry.querySelector('.log-message')?.textContent || '';
            const meta = entry.querySelector('.log-meta')?.textContent || '';
            
            return {
                timestamp,
                level: level.toLowerCase(),
                message,
                source,
                meta: meta ? JSON.parse(meta) : {}
            };
        });

    // Create the export file
    const blob = new Blob([JSON.stringify(logsToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${new Date().toISOString()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showStatus('Logs exported');
});

// Add keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + L to clear logs
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        clearLogBtn.click();
    }
    
    // Ctrl/Cmd + F to focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        logSearch.focus();
    }
    
    // Esc to clear search
    if (e.key === 'Escape' && document.activeElement === logSearch) {
        logSearch.value = '';
        updateLogVisibility();
    }
});

// Load stats immediately and start auto-refresh
async function initStats() {
    try {
        await loadStats(); // Load stats immediately
        // Start auto-refresh only if first load was successful
        setInterval(loadStats, 5000); // Refresh every 5 seconds
    } catch (error) {
        console.error('Failed to load initial stats:', error);
        showStatus('Failed to load system stats. Click Refresh to try again.', true);
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    if (appInitialized) return;
    appInitialized = true;
    // UI Elements
    const cidInput = document.getElementById('cid-input');
    const fetchBtn = document.getElementById('fetch-btn');
    const resolveBtn = document.getElementById('resolve-btn');
    const logsOutput = document.getElementById('logs-output');
    const status = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const newKeyNameInput = document.getElementById('new-key-name');
    const generateKeyBtn = document.getElementById('generate-key-btn');
    const keysList = document.getElementById('keys-list');
    const configEditor = document.getElementById('config-editor');
    const saveConfigBtn = document.getElementById('save-config-btn');
    const refreshStatsBtn = document.getElementById('refresh-stats-btn');
    const systemStats = document.getElementById('system-stats');

    // Extra direct binding for tabs (works even if delegation is blocked by overlay quirks).
    document.querySelectorAll('.tab').forEach((tab) => {
        tab.onclick = () => activateTab(tab.dataset.tab);
    });

    // Event listeners
    fetchBtn.addEventListener('click', () => {
        const cid = cidInput.value.trim();
        fetchLogs(cid);
    });

    resolveBtn.addEventListener('click', resolveIpns);

    generateKeyBtn.addEventListener('click', async () => {
        // Locking the button for the duration of the operation
        generateKeyBtn.disabled = true;
        generateKeyBtn.style.opacity = '0.5';

        try {
            const name = newKeyNameInput.value.trim();
            if (!name) {
                newKeyNameInput.classList.add('error');
                showStatus('Please enter a key name', true);
                return;
            }

            showStatus('Generating IPNS key...');
            const response = await fetch('/api/keys', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name })
            });

            const data = await response.json();
            if (!data.success) {
                newKeyNameInput.classList.add('error');
                showStatus(data.error || 'Failed to generate key', true);
                return;
            }

            showStatus('IPNS key generated successfully');
            newKeyNameInput.value = ''; // Clear input
            newKeyNameInput.classList.remove('error'); // Remove error state if any
            newKeyNameInput.blur(); // Removing the focus from the input field
            
            // Updating the list of keys without additional checks
            const keysResponse = await fetch('/api/keys');
            const keysData = await keysResponse.json();
            if (keysData.success) {
                keysList.innerHTML = '';
                keysData.keys.forEach(keyString => {
                    const parts = keyString.trim().split(/\s+/);
                    const keyName = parts.length > 1 ? parts[parts.length - 1] : 'unnamed';
                    const value = parts.length > 1 ? parts.slice(0, -1).join(' ') : keyString.trim();
                    
                    const keyItem = document.createElement('div');
                    keyItem.className = 'key-item';
                    
                    const keyInfo = document.createElement('div');
                    keyInfo.className = 'key-info';
                    
                    const keyNameEl = document.createElement('div');
                    keyNameEl.className = 'key-name';
                    keyNameEl.style.fontSize = '16px';
                    keyNameEl.style.fontWeight = 'bold';
                    keyNameEl.style.color = '#00ff00';
                    keyNameEl.style.marginBottom = '8px';
                    keyNameEl.style.letterSpacing = '1px';
                    keyNameEl.textContent = keyName;
                    
                    const keyValue = document.createElement('div');
                    keyValue.className = 'key-value';
                    keyValue.style.fontSize = '13px';
                    keyValue.style.fontFamily = 'Share Tech Mono, monospace';
                    keyValue.style.wordBreak = 'break-all';
                    keyValue.style.color = '#a0a0a0';
                    keyValue.style.lineHeight = '1.4';
                    keyValue.style.padding = '8px';
                    keyValue.style.background = 'rgba(0, 0, 0, 0.2)';
                    keyValue.style.borderRadius = '4px';
                    keyValue.style.border = '1px solid rgba(0, 255, 0, 0.1)';
                    keyValue.textContent = value;
                    
                    keyInfo.appendChild(keyNameEl);
                    keyInfo.appendChild(keyValue);
                    
                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'secondary';
                    copyBtn.style.width = 'auto';
                    copyBtn.style.marginLeft = '12px';
                    copyBtn.style.alignSelf = 'center';
                    copyBtn.innerHTML = '<span class="copy-icon">📋</span>Copy';
                    copyBtn.onclick = () => {
                        navigator.clipboard.writeText(value);
                        copyBtn.classList.add('copied');
                        copyBtn.innerHTML = '<span class="copy-icon">✓</span>Copied!';
                        setTimeout(() => {
                            copyBtn.classList.remove('copied');
                            copyBtn.innerHTML = '<span class="copy-icon">📋</span>Copy';
                        }, 1500);
                        showStatus('Key copied to clipboard');
                    };
                    
                    keyItem.appendChild(keyInfo);
                    keyItem.appendChild(copyBtn);
                    keysList.appendChild(keyItem);
                });
            }
        } catch (error) {
            console.error('Key generation error:', error);
            showStatus(error.message, true);
        } finally {
            // Unlock the button anyway
            generateKeyBtn.disabled = false;
            generateKeyBtn.style.opacity = '1';
        }
    });

    saveConfigBtn.addEventListener('click', saveConfig);
    refreshStatsBtn.addEventListener('click', loadStats);
    logTypeFilter?.addEventListener('change', () => {
        if (!latestFetchedLogs.length) return;
        renderFetchedLogs();
    });
    logSortOrder?.addEventListener('change', () => {
        if (!latestFetchedLogs.length) return;
        renderFetchedLogs();
    });
    refreshDistributionBtn?.addEventListener('click', () => {
        if (!latestResolvedCid) {
            showStatus('Resolve IPNS first to visualize distribution', true);
            return;
        }
        loadDistribution(latestResolvedCid);
    });

    // Initial load
    loadKeys();
    loadConfig();
    initStats();
    renderFallbackMapState();
    renderIncidentTimeline();
    activateTab('fetch');
    
    // Start the matrix animation
    setInterval(drawMatrix, 50);
}); 