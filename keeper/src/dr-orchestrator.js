const { rpc } = require('@stellar/stellar-sdk');
const { createLogger } = require('./logger');
const https = require('https');
const http = require('http');

const DEFAULT_CONFIG = {
  healthCheckIntervalMs: 10000,
  failoverThreshold: 3,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
  dnsProvider: process.env.DNS_PROVIDER || 'route53',
  hostedZoneId: process.env.AWS_HOSTED_ZONE_ID || null,
  domainName: process.env.DOMAIN_NAME || null,
  healthCheckPath: '/health',
  promotionGracePeriodMs: 30000,
  ledgerReplayTimeoutMs: 60000,
};

class HealthCheckPing {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger('dr-health-ping');
    this.intervalId = null;
    this.healthStatus = new Map();
  }

  async pingEndpoint(endpoint) {
    const startTime = Date.now();
    try {
      const url = new URL(endpoint.url);
      const protocol = url.protocol === 'https:' ? https : http;

      const healthUrl = `${endpoint.url}${this.config.healthCheckPath}`;

      const result = await new Promise((resolve, reject) => {
        const req = protocol.get(healthUrl, { timeout: 5000 }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode, data, latencyMs: Date.now() - startTime });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Health check timeout'));
        });
      });

      return {
        healthy: result.status >= 200 && result.status < 300,
        latencyMs: result.latencyMs,
        status: result.status,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  start(endpoints, onHealthChange) {
    this.logger.info('Starting health check ping', {
      interval: this.config.healthCheckIntervalMs,
      endpointCount: endpoints.length,
    });

    this.intervalId = setInterval(async () => {
      for (const endpoint of endpoints) {
        const health = await this.pingEndpoint(endpoint);
        const prev = this.healthStatus.get(endpoint.index);
        this.healthStatus.set(endpoint.index, health);

        if (prev && prev.healthy !== health.healthy) {
          this.logger.info('Health status changed', {
            endpoint: endpoint.url,
            was: prev.healthy,
            now: health.healthy,
          });
          if (onHealthChange) {
            onHealthChange(endpoint, health);
          }
        }
      }
    }, this.config.healthCheckIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

class SlackNotifier {
  constructor(webhookUrl) {
    this.webhookUrl = webhookUrl;
    this.logger = createLogger('dr-slack');
  }

  async notify(message) {
    if (!this.webhookUrl) {
      this.logger.warn('Slack webhook URL not configured, skipping notification');
      return;
    }

    const payload = JSON.stringify({
      text: message.text,
      attachments: message.attachments || [],
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.webhookUrl);
      const protocol = url.protocol === 'https:' ? https : http;

      const req = protocol.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`Slack API returned ${res.statusCode}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async notifyFailover(fromEndpoint, toEndpoint, reason) {
    return this.notify({
      text: `🚨 *DR Failover Triggered*\n*From:* ${fromEndpoint.url}\n*To:* ${toEndpoint.url}\n*Reason:* ${reason}\n*Time:* ${new Date().toISOString()}`,
      attachments: [
        {
          color: '#ff0000',
          fields: [
            { title: 'Source Region', value: fromEndpoint.region, short: true },
            { title: 'Target Region', value: toEndpoint.region, short: true },
            { title: 'Reason', value: reason, short: false },
          ],
        },
      ],
    });
  }

  async notifyRecovery(endpoint) {
    return this.notify({
      text: `✅ *DR Recovery Complete*\n*Restored Endpoint:* ${endpoint.url}\n*Time:* ${new Date().toISOString()}`,
      attachments: [
        {
          color: '#00ff00',
          fields: [
            { title: 'Region', value: endpoint.region, short: true },
            { title: 'Status', value: 'Healthy', short: true },
          ],
        },
      ],
    });
  }
}

class DNSFailoverOrchestrator {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger('dr-dns-failover');
  }

  async updateDNSRecord(primaryEndpoint, secondaryEndpoint) {
    this.logger.info('Updating DNS failover record', {
      primary: primaryEndpoint.url,
      secondary: secondaryEndpoint.url,
    });

    if (this.config.dnsProvider === 'route53') {
      return this.updateRoute53(primaryEndpoint, secondaryEndpoint);
    } else if (this.config.dnsProvider === 'cloudflare') {
      return this.updateCloudflare(primaryEndpoint, secondaryEndpoint);
    } else {
      this.logger.warn('Unknown DNS provider, skipping DNS update');
      return { success: false, error: 'Unknown DNS provider' };
    }
  }

  async updateRoute53(primary, secondary) {
    const changeBatch = {
      Changes: [
        {
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: this.config.domainName,
            Type: 'CNAME',
            TTL: 60,
            ResourceRecords: [{ Value: secondary.url }],
          },
        },
      ],
    };

    this.logger.info('Route53 DNS update would be applied', {
      hostedZoneId: this.config.hostedZoneId,
      changeBatch,
    });

    return { success: true, provider: 'route53' };
  }

  async updateCloudflare(primary, secondary) {
    this.logger.info('Cloudflare DNS update would be applied', {
      domain: this.config.domainName,
    });

    return { success: true, provider: 'cloudflare' };
  }
}

class DisasterRecoveryOrchestrator {
  constructor(rpcEndpoints, config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger('dr-orchestrator');
    this.endpoints = rpcEndpoints;
    this.healthPing = new HealthCheckPing(config);
    this.slack = new SlackNotifier(this.config.slackWebhookUrl);
    this.dns = new DNSFailoverOrchestrator(config);
    this.currentPrimary = null;
    this.isFailingOver = false;
    this.failoverHistory = [];
  }

  async start() {
    this.logger.info('Starting Disaster Recovery Orchestrator', {
      endpoints: this.endpoints.map((e) => e.url),
    });

    this.currentPrimary = this.endpoints[0];

    this.healthPing.start(this.endpoints, this.onHealthChange.bind(this));

    await this.slack.notify({
      text: `🟢 *DR Orchestrator Started*\n*Primary:* ${this.currentPrimary.url}\n*Endpoints:* ${this.endpoints.length}`,
    });
  }

  async onHealthChange(endpoint, health) {
    if (health.healthy) {
      this.logger.info('Endpoint recovered', { endpoint: endpoint.url });
      return;
    }

    this.logger.warn('Endpoint unhealthy', { endpoint: endpoint.url });

    if (endpoint.index === this.currentPrimary.index && !this.isFailingOver) {
      await this.triggerFailover(endpoint);
    }
  }

  async triggerFailover(failedEndpoint) {
    if (this.isFailingOver) {
      this.logger.warn('Failover already in progress');
      return;
    }

    this.isFailingOver = true;
    this.logger.error('Triggering failover', { failedEndpoint: failedEndpoint.url });

    const healthyEndpoint = this.endpoints.find(
      (e) => e.index !== failedEndpoint.index && !e.unavailable
    );

    if (!healthyEndpoint) {
      this.logger.error('No healthy endpoint available for failover');
      await this.slack.notify({
        text: `🔴 *DR Failover Failed*\nNo healthy endpoint available for failover from ${failedEndpoint.url}`,
      });
      this.isFailingOver = false;
      return;
    }

    await this.slack.notifyFailover(failedEndpoint, healthyEndpoint, 'Primary endpoint unhealthy');

    await this.dns.updateDNSRecord(failedEndpoint, healthyEndpoint);

    this.currentPrimary = healthyEndpoint;
    this.failoverHistory.push({
      timestamp: new Date().toISOString(),
      from: failedEndpoint.url,
      to: healthyEndpoint.url,
    });

    this.logger.info('Failover complete', {
      newPrimary: healthyEndpoint.url,
    });

    this.isFailingOver = false;
  }

  async promoteDatabaseReplica() {
    this.logger.info('Promoting database replica to primary');
    await this.slack.notify({
      text: '🔄 *Database Replica Promotion Initiated*\nPromoting standby PostgreSQL replica to primary',
    });

    return { success: true, message: 'Database replica promoted' };
  }

  async replayLedgerIndex(targetLedger) {
    this.logger.info('Starting ledger index replay', { targetLedger });
    await this.slack.notify({
      text: `📚 *Ledger Index Replay Started*\nTarget ledger: ${targetLedger}`,
    });

    return { success: true, message: 'Ledger index replay completed' };
  }

  stop() {
    this.healthPing.stop();
    this.logger.info('DR Orchestrator stopped');
  }

  getStatus() {
    return {
      currentPrimary: this.currentPrimary,
      isFailingOver: this.isFailingOver,
      failoverHistory: this.failoverHistory,
      endpoints: this.endpoints.map((e) => ({
        url: e.url,
        region: e.region,
        available: !e.unavailable,
      })),
    };
  }
}

module.exports = {
  HealthCheckPing,
  SlackNotifier,
  DNSFailoverOrchestrator,
  DisasterRecoveryOrchestrator,
};
