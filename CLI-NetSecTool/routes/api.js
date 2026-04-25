import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { networkInterfaces } from 'os';
const router = express.Router();

import ipfsService from '../services/ipfsService.js';
import fetcherService from '../services/fetcherService.js';
import decryptorService from '../services/decryptorService.js';
import configService from '../services/configService.js';
import logger from '../services/loggingService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let config = null;
async function loadConfig() {
    if (!config) {
        config = await configService.get();
    }
    return config;
}

// Fetch data by CID or resolve IPNS
router.post('/fetch', async (req, res, next) => {
    try {
        const { cid, ipnsKey } = req.body;
        if (!cid && !ipnsKey) {
            return res.status(400).json({ success: false, error: 'cid or ipnsKey required' });
        }

        // For IPNS - return resolved CID
        if (ipnsKey) {
            const resolvedCid = await ipfsService.resolveName(ipnsKey);
            return res.json({ success: true, data: resolvedCid });
        }

        // For CID - fetch and decrypt data
        const raw = await fetcherService.fetchFromIPFS(cid);
        const decrypted = await decryptorService.decryptAndParse(raw);
        res.json({ success: true, data: decrypted });
    } catch (err) {
        next(err);
    }
});

// IPNS key management
router.get('/keys', async (_req, res, next) => {
    try {
        const keys = await ipfsService.listKeys();
        res.json({ success: true, keys });
    } catch (e) {
        next(e);
    }
});

router.post('/keys', async (req, res, next) => {
    const keyName = req.body.name;
    
    try {
        if (!keyName) {
            return res.status(400).json({ success: false, error: 'name required' });
        }

        // Проверяем существование ключа перед созданием
        const existingKeys = await ipfsService.listKeys();
        const exists = existingKeys.some(key => {
            const parts = key.trim().split(/\s+/);
            const existingKeyName = parts[parts.length - 1];
            return existingKeyName === keyName;
        });

        if (exists) {
            logger.warn('Attempted to create duplicate IPNS key', { 
                name: keyName,
                source: 'api'
            });
            return res.status(400).json({ 
                success: false, 
                error: `Key with name '${keyName}' already exists`
            });
        }

        // Создаем ключ
        logger.info('Creating new IPNS key', { name: keyName, source: 'api' });
        const key = await ipfsService.createKey(keyName);
        
        logger.info('IPNS key created successfully', { 
            name: keyName,
            source: 'api'
        });
        
        res.json({ success: true, key });
    } catch (e) {
        logger.error('Failed to create IPNS key', {
            name: keyName,
            error: e.message,
            stack: e.stack,
            source: 'api'
        });
        next(e);
    }
});

// Config management
router.get('/config', async (_req, res, next) => {
    try {
        const cfg = await configService.get();
        res.json({ success: true, config: cfg });
    } catch (e) {
        next(e);
    }
});

router.post('/config', async (req, res, next) => {
    try {
        const config = req.body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({
                success: false,
                error: 'Invalid configuration format'
            });
        }

        // Check required sections
        const requiredSections = [
            'network', 
            'server', 
            'ipfs', 
            'encryption', 
            'logging', 
            'security',
            'performance'
        ];

        for (const section of requiredSections) {
            if (!config[section] || typeof config[section] !== 'object') {
                return res.status(400).json({
                    success: false,
                    error: `Missing or invalid required section: ${section}`
                });
            }
        }

        // Validate network settings
        const network = config.network;
        if (!network.default_port || !network.default_host || 
            !network.connection_timeout || !network.max_retries ||
            !network.process_kill_timeout || !network.cleanup_wait_timeout ||
            !network.daemon_shutdown_timeout || !network.stats_update_interval ||
            !network.ping_timeout || !network.interface_speed_detection) {
            return res.status(400).json({
                success: false,
                error: 'Invalid network configuration'
            });
        }

        // Validate server settings
        const server = config.server;
        if (!server.port || !server.host || !server.static_dir || !server.api_prefix ||
            !server.cors || !server.rate_limit) {
            return res.status(400).json({
                success: false,
                error: 'Invalid server configuration'
            });
        }

        // Validate IPFS settings
        const ipfs = config.ipfs;
        const requiredIpfsFields = {
            api_url: 'string',
            timeout: 'number',
            max_retries: 'number',
            allow_offline: 'boolean',
            allow_online: 'boolean',
            pin_enabled: 'boolean',
            name_resolve_timeout: 'string',
            pid_file: 'string',
            repo_dir: 'string'
        };

        const missingFields = [];
        const invalidFields = [];

        for (const [field, expectedType] of Object.entries(requiredIpfsFields)) {
            if (ipfs[field] === undefined || ipfs[field] === null) {
                missingFields.push(field);
            } else if (typeof ipfs[field] !== expectedType) {
                invalidFields.push(`${field} (expected ${expectedType}, got ${typeof ipfs[field]})`);
            }
        }

        if (missingFields.length > 0 || invalidFields.length > 0) {
            let error = 'Invalid IPFS configuration.';
            if (missingFields.length > 0) {
                error += ` Missing fields: ${missingFields.join(', ')}.`;
            }
            if (invalidFields.length > 0) {
                error += ` Invalid field types: ${invalidFields.join(', ')}.`;
            }
            return res.status(400).json({
                success: false,
                error: error
            });
        }

        // Check IPFS timeout
        if (ipfs.timeout <= 0) {
            return res.status(400).json({
                success: false,
                error: 'IPFS timeout must be a positive number'
            });
        }

        // Check retry count
        if (ipfs.max_retries < 0) {
            return res.status(400).json({
                success: false,
                error: 'IPFS max_retries must be a non-negative number'
            });
        }

        // Check timeout format
        if (!ipfs.name_resolve_timeout.match(/^\d+[smh]$/)) {
            return res.status(400).json({
                success: false,
                error: 'IPFS name_resolve_timeout must be a string like "30s", "5m", or "1h"'
            });
        }

        // Check API URL
        try {
            const url = new URL(ipfs.api_url);
            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new Error('Invalid protocol');
            }
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'IPFS api_url must be a valid HTTP or HTTPS URL'
            });
        }

        // Validate encryption settings
        const encryption = config.encryption;
        if (!encryption.default_cipher || !encryption.key_size || 
            !encryption.private_key_file || !encryption.ipns_key_file ||
            !encryption.key_derivation || !encryption.pbkdf2_iterations ||
            !encryption.pbkdf2_digest || !encryption.backup_path) {
            return res.status(400).json({
                success: false,
                error: 'Invalid encryption configuration'
            });
        }

        // Validate logging settings
        const logging = config.logging;
        if (!logging.log_file || !logging.log_level || !logging.max_log_size ||
            !logging.max_log_files || typeof logging.enable_console !== 'boolean' ||
            typeof logging.enable_file !== 'boolean' || !logging.format ||
            !logging.timestamp_format || !logging.log_dir || !logging.output_file ||
            !logging.error_handling || !logging.log_rotation || !logging.categories) {
            return res.status(400).json({
                success: false,
                error: 'Invalid logging configuration'
            });
        }

        // Validate security settings
        const security = config.security;
        if (!security.rate_limiting || !security.cors || 
            !security.api_keys || !security.ip_whitelist) {
            return res.status(400).json({
                success: false,
                error: 'Invalid security configuration'
            });
        }

        // Validate performance settings
        const performance = config.performance;
        if (!performance.cache || !performance.compression || 
            !performance.batch_processing) {
            return res.status(400).json({
                success: false,
                error: 'Invalid performance configuration'
            });
        }

        // Save and reload config
        await configService.saveConfig(config);
        logger.info('Configuration updated via web interface', { 
            source: 'api',
            sections: Object.keys(config)
        });

        // Reload services
        try {
            await ipfsService.loadConfig();
            await logger.reloadConfig();
        } catch (error) {
            logger.warn('Error reloading service configurations', { 
                error: error.message,
                stack: error.stack
            });
        }

        res.json({ success: true });
    } catch (e) {
        logger.error('Failed to save configuration', { 
            error: e.message,
            stack: e.stack
        });
        next(e);
    }
});

// System stats
router.get('/stats', async (_req, res) => {
    const cfg = await loadConfig();
    
    // Get memory usage
    const memory = process.memoryUsage();
    const rss = Math.round(memory.rss / 1024 / 1024);
    const totalSystemMemory = Math.round(os.totalmem() / 1024 / 1024);
    const memoryPercentage = ((memory.rss / os.totalmem()) * 100).toFixed(1);

    // Get uptimes
    const systemUptime = os.uptime();
    const systemUptimeFormatted = formatUptime(systemUptime);
    const processUptime = process.uptime();
    const processUptimeFormatted = formatUptime(processUptime);

    // Get CPU usage
    const cpuCount = os.cpus().length;
    const startUsage = process.cpuUsage();
    await new Promise(resolve => setTimeout(resolve, cfg.network.stats_update_interval));
    const endUsage = process.cpuUsage(startUsage);
    const userCPUMs = endUsage.user / 1000;
    const sysCPUMs = endUsage.system / 1000;
    const totalCPUMs = userCPUMs + sysCPUMs;
    const totalCPUPercent = ((totalCPUMs / (cfg.network.stats_update_interval * cpuCount)) * 100).toFixed(1);

    // Get network stats
    const networkStats = {};
    const interfaces = os.networkInterfaces();
    let prevStats = {};

    // Load previous stats
    try {
        const statsFile = path.join(process.cwd(), cfg.logging.stats_file);
        if (fs.existsSync(statsFile)) {
            prevStats = JSON.parse(await fs.promises.readFile(statsFile, 'utf8'));
        }
    } catch (e) {
        logger.error('Error reading network stats:', e);
    }

    const currentTime = Date.now();
    const newStats = { timestamp: currentTime, interfaces: {} };

    // Detect network interface speed
    async function detectMaxSpeed(name, platform) {
        const speedConfig = cfg.network.interface_speed_detection;

        // Skip VPN interfaces
        if (name.startsWith('utun') || name.startsWith('tun') || name.startsWith('ppp') || name.startsWith('vpn')) {
            return speedConfig.other.default;
        }

        if (platform === 'linux') {
            try {
                const { execSync } = await import('child_process');
                try {
                    // `ethtool` can print scary netlink errors on Wi-Fi or without permissions.
                    // Suppress stderr so the demo UI doesn't get flooded with noise.
                    const ethtoolOutput = execSync(`ethtool ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                    const speedMatch = ethtoolOutput.match(/Speed: (\d+)Mb\/s/);
                    if (speedMatch) {
                        return parseInt(speedMatch[1]);
                    }
                } catch (e) {
                    // ethtool might not be available
                }

                const speedPath = `/sys/class/net/${name}/speed`;
                if (fs.existsSync(speedPath)) {
                    try {
                        const speed = parseInt(await fs.promises.readFile(speedPath, 'utf8'));
                        if (!isNaN(speed) && speed > 0) return speed;
                    } catch (e) {
                        // Wi-Fi commonly returns EINVAL here. Not fatal; just fall back.
                        logger.debug?.(`Speed file not readable for ${name}: ${e.message}`);
                    }
                }
            } catch (e) {
                logger.debug?.(`Error detecting speed for ${name}: ${e.message}`);
            }
        } else if (platform === 'darwin') {
            try {
                const { execSync } = await import('child_process');
                const linkInfo = execSync(`networksetup -getmedia ${name}`, { encoding: 'utf8' });

                if (linkInfo.includes('1000baseT') || linkInfo.includes('1000baseTX')) {
                    return speedConfig.ethernet.gigabit;
                } else if (linkInfo.includes('100baseT') || linkInfo.includes('100baseTX')) {
                    return speedConfig.ethernet.default;
                }

                const ifconfigOutput = execSync(`ifconfig ${name}`, { encoding: 'utf8' });
                if (ifconfigOutput.includes('1000baseT')) {
                    return speedConfig.ethernet.gigabit;
                } else if (ifconfigOutput.includes('100baseTX')) {
                    return speedConfig.ethernet.default;
                }
            } catch (e) {
                logger.error(`Error detecting speed for ${name}:`, e);
            }
        }

        // Detect speed by interface type
        if (name.startsWith('en') || name.startsWith('eth')) {
            try {
                const { execSync } = await import('child_process');
                const ping = execSync(`ping -c 1 -W ${cfg.network.ping_timeout/1000} localhost`, { encoding: 'utf8' });
                if (ping.includes('time=0.')) {
                    return speedConfig.ethernet.gigabit;
                }
            } catch (e) {}
            return speedConfig.ethernet.default;
        } else if (name.startsWith('wl')) {
            return speedConfig.wifi.default;
        }

        return speedConfig.other.default;
    }

    // Collect network interface stats
    for (const [name, addrs] of Object.entries(interfaces)) {
        const ipv4 = addrs.find(addr => addr.family === 'IPv4' && !addr.internal);
        if (ipv4) {
            try {
                let rxBytes = '0', txBytes = '0';

                // Skip VPN interfaces
                if (name.startsWith('utun') || name.startsWith('tun') || name.startsWith('ppp') || name.startsWith('vpn')) {
                    continue;
                }

                const detectedSpeed = await detectMaxSpeed(name, process.platform);

                if (process.platform === 'linux') {
                    try {
                        rxBytes = await fs.promises.readFile(`/sys/class/net/${name}/statistics/rx_bytes`, 'utf8');
                        txBytes = await fs.promises.readFile(`/sys/class/net/${name}/statistics/tx_bytes`, 'utf8');
                    } catch (e) {
                        logger.error(`Error reading Linux network stats: ${e.message}`);
                    }
                } else if (process.platform === 'darwin') {
                    try {
                        const { execSync } = await import('child_process');
                        const output = execSync(`netstat -I ${name} -b`, { encoding: 'utf8' });
                        const lines = output.trim().split('\n');
                        if (lines.length >= 2) {
                            const values = lines[1].trim().split(/\s+/);
                            rxBytes = (parseInt(values[6]) || 0).toString();
                            txBytes = (parseInt(values[9]) || 0).toString();
                        }
                    } catch (e) {
                        logger.error(`Error reading MacOS network stats: ${e.message}`);
                    }
                }

                const rx = parseInt(rxBytes);
                const tx = parseInt(txBytes);

                networkStats[name] = {
                    address: ipv4.address,
                    rx,
                    tx,
                    maxSpeed: detectedSpeed
                };

                if (prevStats.interfaces && prevStats.interfaces[name]) {
                    const timeDiff = (currentTime - prevStats.timestamp) / 1000;
                    if (timeDiff > 0) {
                        const rxDiff = rx - prevStats.interfaces[name].rx;
                        const txDiff = tx - prevStats.interfaces[name].tx;

                        networkStats[name].rxSpeed = Math.max(0, Math.round(rxDiff / timeDiff));
                        networkStats[name].txSpeed = Math.max(0, Math.round(txDiff / timeDiff));
                    }
                }

                newStats.interfaces[name] = { rx, tx };
            } catch (e) {
                logger.error(`Error getting stats for ${name}:`, e);
                networkStats[name] = {
                    address: ipv4.address,
                    error: 'Failed to get network statistics'
                };
            }
        }
    }

    // Save current stats
    try {
        const statsFile = path.join(process.cwd(), cfg.logging.stats_file);
        await fs.promises.writeFile(statsFile, JSON.stringify(newStats), 'utf8');
    } catch (e) {
        logger.error('Error saving network stats:', e);
    }

    res.json({
        success: true,
        stats: {
            system: {
                uptime: systemUptime,
                uptimeFormatted: systemUptimeFormatted,
                totalMemory: totalSystemMemory
            },
            process: {
                uptime: processUptime,
                uptimeFormatted: processUptimeFormatted,
                memory: {
                    rss,
                    percentage: memoryPercentage
                },
                cpu: {
                    percentage: totalCPUPercent,
                    cores: cpuCount
                }
            },
            network: networkStats
        }
    });
});

// Format uptime to human readable string
function formatUptime(uptime) {
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
}

// Log management
router.post('/logs', async (req, res, next) => {
    try {
        const { level, message, meta } = req.body;
        
        // Validate required fields
        if (!level || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'level and message required' 
            });
        }

        // Validate log level
        const validLevels = ['error', 'warn', 'info', 'debug'];
        if (!validLevels.includes(level.toLowerCase())) {
            return res.status(400).json({ 
                success: false, 
                error: `Invalid log level. Must be one of: ${validLevels.join(', ')}` 
            });
        }

        // Validate message
        if (typeof message !== 'string' || message.length > 10000) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid message format or length' 
            });
        }

        // Validate meta
        if (meta && typeof meta !== 'object') {
            return res.status(400).json({ 
                success: false, 
                error: 'Meta must be an object' 
            });
        }

        // Clean meta object
        const cleanMeta = meta ? JSON.parse(JSON.stringify({
            source: 'web',
            ...meta
        })) : { source: 'web' };

        // Write log with retry
        let retryCount = 0;
        const maxRetries = 3;
        let lastError = null;

        while (retryCount < maxRetries) {
            try {
                await logger[level.toLowerCase()](message, cleanMeta);
                return res.json({ success: true });
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
        throw lastError;
    } catch (err) {
        // Log the error but don't expose internal details to client
        logger.error('Failed to write log', { 
            error: err.message,
            stack: err.stack,
            source: 'api'
        });
        
        res.status(500).json({ 
            success: false, 
            error: 'Failed to write log. Please try again later.' 
        });
    }
});

// System logs
router.get('/logs', async (_req, res, next) => {
    try {
        const cfg = await loadConfig();
        const logFile = path.join(process.cwd(), cfg.logging.log_file);

        // Check if log file exists
        if (!fs.existsSync(logFile)) {
            return res.json({ success: true, logs: [] });
        }

        // Read logs with retry
        let retryCount = 0;
        const maxRetries = 3;
        let lastError = null;

        while (retryCount < maxRetries) {
            try {
                const logs = await fs.promises.readFile(logFile, 'utf-8');
                const logEntries = logs.split('\n')
                    .filter(line => line.trim())
                    .map(line => {
                        try {
                            return JSON.parse(line);
                        } catch (e) {
                            return {
                                timestamp: new Date().toISOString(),
                                level: cfg.logging.log_level,
                                message: line,
                                meta: { source: 'system' }
                            };
                        }
                    })
                    // Filter out invalid entries
                    .filter(entry => 
                        entry && 
                        typeof entry.message === 'string' && 
                        typeof entry.timestamp === 'string'
                    )
                    // Sort by timestamp, newest first
                    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                    // Limit to last 1000 entries
                    .slice(0, 1000);

                return res.json({ success: true, logs: logEntries });
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
        throw lastError;
    } catch (err) {
        logger.error('Failed to read logs', { 
            error: err.message,
            stack: err.stack,
            source: 'api'
        });
        
        res.status(500).json({ 
            success: false, 
            error: 'Failed to read logs. Please try again later.' 
        });
    }
});

// Clear logs
router.post('/logs/clear', async (_req, res, next) => {
    try {
        const cfg = await loadConfig();
        const logFile = path.join(process.cwd(), cfg.logging.log_file);

        // Clear logs with retry
        let retryCount = 0;
        const maxRetries = 3;
        let lastError = null;

        while (retryCount < maxRetries) {
            try {
                await fs.promises.writeFile(logFile, '', 'utf-8');
                logger.info('Logs cleared via web interface', { source: 'api' });
                return res.json({ success: true });
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
        throw lastError;
    } catch (err) {
        logger.error('Failed to clear logs', { 
            error: err.message,
            stack: err.stack,
            source: 'api'
        });
        
        res.status(500).json({ 
            success: false, 
            error: 'Failed to clear logs. Please try again later.' 
        });
    }
});

export default router; 