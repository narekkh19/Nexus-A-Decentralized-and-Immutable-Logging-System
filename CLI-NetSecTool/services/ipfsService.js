import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fetch from 'node-fetch';
import configService from './configService.js';
import logger from './loggingService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Run IPFS command with timeout
function runIpfs(args, timeout) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ipfs', args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`IPFS command timed out after ${timeout}ms`));
        }, timeout);

        proc.stdout.on('data', (d) => (stdout += d));
        proc.stderr.on('data', (d) => (stderr += d));

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) return resolve(stdout.trim());
            reject(new Error(stderr.trim() || `ipfs exited with code ${code}`));
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Nexus-CLI',
                'Accept': '*/*'
            },
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

class IpfsService {
    constructor() {
        this.config = null;
        this.loadConfig();
    }

    // Load IPFS and encryption config
    async loadConfig() {
        this.config = await configService.get('ipfs');
        this.encryption = await configService.get('encryption');
    }

    // Run IPFS command with retries
    async runWithRetry(args) {
        if (!this.config) await this.loadConfig();
        
        let lastError;
        for (let i = 0; i < this.config.max_retries; i++) {
            try {
                return await runIpfs(args, this.config.timeout);
            } catch (err) {
                lastError = err;
                if (i < this.config.max_retries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        throw lastError;
    }

    // Add file to IPFS
    async addData(filePath) {
        const args = ['add', '-Q'];
        if (!this.config.pin_enabled) {
            args.push('--pin=false');
        }
        if (this.config.pin_recursive === false) {
            args.push('--recursive=false');
        }
        args.push(filePath);
        return this.runWithRetry(args);
    }

    /**
     * Fetch raw block via local Kubo CLI (same machine as daemon). Works when the block
     * exists in the local repo; avoids public gateway 504/DNS issues.
     */
    async catCid(cid) {
        const cidClean = String(cid).trim();
        if (!cidClean) throw new Error('empty CID');
        return this.runWithRetry(['cat', cidClean]);
    }

    /**
     * Fetch by CID: local Kubo first (cat), then local gateway, then remote gateways.
     * connection_mode: "api" = this full order; "gateway" = skip cat, use HTTP gateways only
     * (for hosts without `ipfs` CLI). prefer_local_kubo_cat=false forces gateway-only.
     */
    async getData(cid) {
        if (!this.config) await this.loadConfig();
        const cidClean = String(cid).trim();
        const errors = [];
        const mode = this.config.connection_mode || 'api';
        const preferCat = this.config.prefer_local_kubo_cat !== false;

        logger.info('Fetching data from IPFS', { cid: cidClean, operation: 'fetch', connection_mode: mode });

        if (mode !== 'gateway' && preferCat) {
            try {
                const text = await this.catCid(cidClean);
                if (text && text.length > 0) {
                    logger.info('Fetched via local ipfs cat', { cid: cidClean, size: text.length, operation: 'fetch' });
                    return text;
                }
            } catch (err) {
                errors.push(`ipfs cat: ${err.message}`);
            }
        }

        const gateways = [
            this.config.local_gateway_url,
            this.config.gateway_url,
            ...(this.config.use_fallback_gateways ? (this.config.fallback_gateways || []) : [])
        ].filter(Boolean);

        for (const gateway of gateways) {
            for (let i = 0; i < this.config.max_retries; i++) {
                try {
                    const response = await fetchWithTimeout(`${gateway}${cidClean}`, this.config.timeout);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const text = await response.text();
                    logger.info('Fetched via HTTP gateway', {
                        cid: cidClean,
                        gateway,
                        operation: 'fetch',
                        size: text.length
                    });
                    return text;
                } catch (err) {
                    errors.push(`${gateway} attempt ${i + 1}: ${err.message}`);
                }
            }
        }

        throw new Error(`Failed to fetch CID: ${errors.join(' | ')}`);
    }

    // Resolve IPNS name to CID
    async resolveName(ipnsKeyOrPeerId) {
        try {
            if (!this.config) await this.loadConfig();
            
            logger.info('Starting IPNS resolve', { operation: 'resolve' });

            // Read IPNS key from file
            const keyPath = path.resolve(process.cwd(), this.encryption.ipns_key_file);
            let peerId = (ipnsKeyOrPeerId || '').trim();
            if (!peerId) {
                try {
                    peerId = await fs.readFile(keyPath, 'utf-8');
                    peerId = peerId.trim();
                    logger.debug('Read IPNS key from file', { keyPath, operation: 'resolve' });
                } catch (err) {
                    logger.error('Failed to read IPNS key file', {
                        keyPath,
                        error: err.message,
                        operation: 'resolve'
                    });
                    throw new Error(`Cannot read IPNS key file: ${keyPath}`);
                }
            }

            if (!peerId) {
                logger.error('Empty IPNS key file', { keyPath, operation: 'resolve' });
                throw new Error('IPNS key file is empty');
            }

            // Normalize '/ipns/<id>' input and resolve local key names to peer IDs.
            peerId = peerId.replace(/^\/ipns\//, '').trim();
            if (!peerId.startsWith('k') && !peerId.startsWith('Qm')) {
                const keyOutput = await this.runWithRetry(['key', 'list', '-l']);
                const match = keyOutput
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => line.split(/\s+/))
                    .find((parts) => parts.length >= 2 && parts[parts.length - 1] === peerId);

                if (match) {
                    const resolvedPeerId = match.slice(0, -1).join(' ');
                    logger.debug('Resolved local IPFS key name to peer ID', {
                        keyName: peerId,
                        resolvedPeerId,
                        operation: 'resolve'
                    });
                    peerId = resolvedPeerId;
                }
            }

            // Build base resolve command
            const baseArgs = [
                'name',
                'resolve',
                '--nocache',
                '--timeout', this.config.name_resolve_timeout
            ];
            const target = `/ipns/${peerId}`;
            let result = null;
            let offlineError = null;

            // First attempt offline when configured (fast path for local cache/local records).
            if (this.config.allow_offline) {
                const offlineArgs = [...baseArgs, '--offline', target];
                logger.debug('Resolving IPNS name (offline attempt)', {
                    peerId,
                    args: offlineArgs,
                    operation: 'resolve'
                });
                try {
                    result = await this.runWithRetry(offlineArgs);
                } catch (err) {
                    offlineError = err;
                    logger.warn('Offline IPNS resolve failed, retrying online', {
                        peerId,
                        error: err.message,
                        operation: 'resolve'
                    });
                }
            }

            // Fallback to online resolve to retrieve remote Linux-published IPNS records.
            if (!result && this.config.allow_online) {
                const onlineArgs = [...baseArgs, target];
                logger.debug('Resolving IPNS name (online attempt)', {
                    peerId,
                    args: onlineArgs,
                    operation: 'resolve'
                });
                result = await this.runWithRetry(onlineArgs);
            }

            if (!result && offlineError) {
                throw offlineError;
            }
            if (!result) {
                throw new Error('IPNS resolve disabled by configuration (both offline and online are false)');
            }
            
            // Parse result
            const prefix = '/ipfs/';
            const pos = result.indexOf(prefix);
            if (pos === -1) {
                logger.error('Invalid resolve result', { 
                    result, 
                    operation: 'resolve' 
                });
                throw new Error(`Invalid resolve result: ${result}`);
            }

            const resolvedCid = result.substring(pos + prefix.length).trim();
            logger.info('Successfully resolved IPNS name', { 
                peerId, 
                resolvedCid, 
                operation: 'resolve' 
            });

            return resolvedCid;
        } catch (err) {
            // Add more context to error
            if (err.message.includes('no link named')) {
                logger.warn('IPNS name not published yet', { operation: 'resolve' });
                throw new Error('IPNS name not published yet. Please publish content first.');
            }
            if (err.message.includes('DNSLink lookup') && (ipnsKeyOrPeerId || '').trim()) {
                throw new Error(`IPNS resolve failed: '${(ipnsKeyOrPeerId || '').trim()}' looks like a local key name that is not mapped to a peer ID`);
            }
            logger.error('Failed to resolve IPNS name', { 
                error: err.message, 
                operation: 'resolve',
                stack: err.stack
            });
            throw new Error(`IPNS resolve failed: ${err.message}`);
        }
    }

    // List IPFS keys
    async listKeys() {
        const output = await this.runWithRetry(['key', 'list', '-l']);
        return output.split('\n')
            .filter(Boolean)
            .map(line => {
                // Format: k51qzi5uqu5dkml4vrxkesf5e1of62xic6s0un5bw4sq83f1av3jlotel9kpxs self
                // First part is key value, second is name
                const parts = line.trim().split(/\s+/);
                if (parts.length < 2) {
                    return line.trim(); // Return whole line if no space
                }
                // Last word is name, rest is value
                const name = parts[parts.length - 1];
                const value = parts.slice(0, -1).join(' ');
                return `${value} ${name}`; // Return in "value name" format
            });
    }

    // Create new IPFS key
    async createKey(name) {
        const args = [
            'key',
            'gen',
            '--type=rsa',
            '--size=2048',
            name
        ];
        return this.runWithRetry(args);
    }
}

export default new IpfsService(); 