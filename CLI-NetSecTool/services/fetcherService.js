import fetch from 'node-fetch';
import ipfsService from './ipfsService.js';
import configService from './configService.js';

class FetcherService {
  constructor() {
    this.config = null;
    this.loadConfig();
  }

  async loadConfig() {
    this.config = await configService.get('ipfs');
  }

  // Fetch data from IPFS gateway
  async fetchFromGateway(cid, gateway) {
    try {
      const response = await fetch(`${gateway}${cid}`, {
        timeout: this.config.timeout,
        headers: {
          'User-Agent': 'Nexus-CLI'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Gateway responded with status ${response.status}`);
      }
      
      return await response.text();
    } catch (e) {
      throw new Error(`Gateway ${gateway} failed: ${e.message}`);
    }
  }

  // Fetch data: unified in ipfsService.getData (ipfs cat → local gateway → public gateways).
  async fetchFromIPFS(cid) {
    if (!this.config) await this.loadConfig();
    return ipfsService.getData(cid);
  }

  // Resolve IPNS key to CID
  async resolveIPNSKey() {
    try {
      const config = await configService.get('ipfs');
      const resolvedCID = await ipfsService.resolveName(config.ipns_key_name);
      return resolvedCID;
    } catch (err) {
      throw new Error(`Failed to resolve IPNS key: ${err.message}`);
    }
  }
}

export default new FetcherService(); 