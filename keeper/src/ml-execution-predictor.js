'use strict';

const { createLogger } = require('./logger');
const crypto = require('crypto');

const CONFIDENCE_THRESHOLD = 0.85;
const FEATURE_COUNT = 12;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

class ExecutionHistoryTracker {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('execution-history');
    this.maxHistorySize = options.maxHistorySize || 10000;
    this.history = new Map();
  }

  recordExecution(taskId, contractId, success, gasUsed, timestamp) {
    const key = `${taskId}:${contractId}`;
    if (!this.history.has(key)) {
      this.history.set(key, {
        taskId,
        contractId,
        executions: [],
      });
    }

    const record = this.history.get(key);
    record.executions.push({
      success,
      gasUsed,
      timestamp: timestamp || Date.now(),
    });

    if (record.executions.length > this.maxHistorySize) {
      record.executions = record.executions.slice(-this.maxHistorySize);
    }

    return record;
  }

  getExecutionSummary(taskId, contractId) {
    const key = `${taskId}:${contractId}`;
    const record = this.history.get(key);
    if (!record) {
      return { successCount: 0, failureCount: 0, sampleCount: 0 };
    }

    const recentExecutions = record.executions.filter(
      (e) => Date.now() - e.timestamp < HISTORY_WINDOW_MS
    );

    return {
      successCount: recentExecutions.filter((e) => e.success).length,
      failureCount: recentExecutions.filter((e) => !e.success).length,
      sampleCount: recentExecutions.length,
      avgGasUsed: recentExecutions.length > 0
        ? recentExecutions.reduce((sum, e) => sum + e.gasUsed, 0) / recentExecutions.length
        : 0,
    };
  }

  getContractFailureRate(contractId) {
    let totalExecutions = 0;
    let totalFailures = 0;

    for (const [, record] of this.history) {
      if (record.contractId === contractId) {
        const recent = record.executions.filter(
          (e) => Date.now() - e.timestamp < HISTORY_WINDOW_MS
        );
        totalExecutions += recent.length;
        totalFailures += recent.filter((e) => !e.success).length;
      }
    }

    return totalExecutions > 0 ? totalFailures / totalExecutions : 0;
  }

  cleanup(maxAgeMs = HISTORY_WINDOW_MS * 7) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, record] of this.history) {
      record.executions = record.executions.filter((e) => e.timestamp > cutoff);
      if (record.executions.length === 0) {
        this.history.delete(key);
      }
    }
  }
}

class MLExecutionFailurePredictor {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('ml-predictor');
    this.historyTracker = options.historyTracker || new ExecutionHistoryTracker();
    this.confidenceThreshold = options.confidenceThreshold || CONFIDENCE_THRESHOLD;
    this.modelWeights = this.initializeWeights();
  }

  initializeWeights() {
    return {
      historicalFailureRate: 0.25,
      gasVolatility: 0.12,
      contractAge: 0.08,
      executionFrequency: 0.10,
      networkCongestion: 0.08,
      timeSinceLastExecution: 0.07,
      argumentComplexity: 0.06,
      functionRiskLevel: 0.08,
      recentErrorPattern: 0.06,
      gasPriceDeviation: 0.04,
      blockHeightDelta: 0.03,
      mempoolDepth: 0.03,
    };
  }

  extractFeatures(context) {
    const {
      taskId,
      contractId,
      functionName,
      args,
      currentGasPrice,
      historicalGasPrices,
      networkStats,
      lastExecutionTime,
      contractCreateTime,
      recentErrors,
      mempoolSize,
      currentBlockHeight,
    } = context;

    const summary = this.historyTracker.getExecutionSummary(taskId, contractId);
    const contractFailureRate = this.historyTracker.getContractFailureRate(contractId);

    const gasVolatility = this.calculateGasVolatility(historicalGasPrices || []);
    const networkCongestion = this.calculateNetworkCongestion(networkStats);
    const argumentComplexity = this.calculateArgumentComplexity(args || []);
    const functionRisk = this.calculateFunctionRiskLevel(functionName);
    const recentErrorScore = this.calculateRecentErrorScore(recentErrors || []);
    const gasPriceDeviation = this.calculateGasPriceDeviation(currentGasPrice, historicalGasPrices || []);
    const blockDelta = currentBlockHeight ? Math.min((currentBlockHeight % 100) / 100, 1) : 0;
    const mempoolScore = mempoolSize ? Math.min(mempoolSize / 1000, 1) : 0;
    const contractAgeScore = contractCreateTime ? Math.min((Date.now() - contractCreateTime) / (30 * 24 * 60 * 60 * 1000), 1) : 0.5;
    const execFrequency = summary.sampleCount > 0 ? Math.min(summary.sampleCount / 100, 1) : 0;
    const timeSinceLast = lastExecutionTime ? Math.min((Date.now() - lastExecutionTime) / (24 * 60 * 60 * 1000), 1) : 1;

    return {
      historicalFailureRate: contractFailureRate,
      gasVolatility,
      contractAge: contractAgeScore,
      executionFrequency: execFrequency,
      networkCongestion,
      timeSinceLastExecution: timeSinceLast,
      argumentComplexity,
      functionRiskLevel: functionRisk,
      recentErrorPattern: recentErrorScore,
      gasPriceDeviation,
      blockHeightDelta: blockDelta,
      mempoolDepth: mempoolScore,
    };
  }

  calculateGasVolatility(gasPrices) {
    if (gasPrices.length < 2) return 0;
    const mean = gasPrices.reduce((a, b) => a + b, 0) / gasPrices.length;
    const variance = gasPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / gasPrices.length;
    const stdDev = Math.sqrt(variance);
    return Math.min(stdDev / mean || 0, 1);
  }

  calculateNetworkCongestion(networkStats) {
    if (!networkStats) return 0.5;
    const ledgerCloseRate = networkStats.ledgerCloseRate || 1;
    const targetRate = 10;
    return Math.min(ledgerCloseRate / targetRate, 1);
  }

  calculateArgumentComplexity(args) {
    if (!args || args.length === 0) return 0;
    const complexityScore = args.reduce((score, arg) => {
      if (typeof arg === 'string') return score + arg.length / 100;
      if (typeof arg === 'number') return score + 0.1;
      if (typeof arg === 'object') return score + 0.3;
      return score + 0.2;
    }, 0);
    return Math.min(complexityScore, 1);
  }

  calculateFunctionRiskLevel(functionName) {
    const highRiskFunctions = ['transfer', 'approve', 'mint', 'burn', 'upgrade', 'migrate'];
    const mediumRiskFunctions = ['swap', 'stake', 'unstake', 'claim'];
    const name = (functionName || '').toLowerCase();

    if (highRiskFunctions.some((f) => name.includes(f))) return 0.9;
    if (mediumRiskFunctions.some((f) => name.includes(f))) return 0.6;
    return 0.2;
  }

  calculateRecentErrorScore(errors) {
    if (errors.length === 0) return 0;
    const recentErrors = errors.filter((e) => Date.now() - e.timestamp < 3600000);
    return Math.min(recentErrors.length / 10, 1);
  }

  calculateGasPriceDeviation(currentPrice, historicalPrices) {
    if (historicalPrices.length < 2) return 0;
    const mean = historicalPrices.reduce((a, b) => a + b, 0) / historicalPrices.length;
    return Math.min(Math.abs(currentPrice - mean) / mean || 0, 1);
  }

  predict(context) {
    const features = this.extractFeatures(context);

    let weightedScore = 0;
    let totalWeight = 0;

    for (const [feature, weight] of Object.entries(this.modelWeights)) {
      if (features[feature] !== undefined) {
        weightedScore += features[feature] * weight;
        totalWeight += weight;
      }
    }

    const confidence = totalWeight > 0 ? weightedScore / totalWeight : 0;

    const prediction = {
      taskId: context.taskId,
      contractId: context.contractId,
      confidence: Math.round(confidence * 100) / 100,
      shouldSkip: confidence >= this.confidenceThreshold,
      riskLevel: this.classifyRisk(confidence),
      features,
      modelVersion: '1.0.0',
      timestamp: new Date().toISOString(),
    };

    this.logger.info('Prediction made', {
      taskId: context.taskId,
      confidence: prediction.confidence,
      shouldSkip: prediction.shouldSkip,
      riskLevel: prediction.riskLevel,
    });

    return prediction;
  }

  classifyRisk(confidence) {
    if (confidence >= 0.8) return 'critical';
    if (confidence >= 0.6) return 'high';
    if (confidence >= 0.4) return 'medium';
    return 'low';
  }

  shouldExecuteSimulation(prediction) {
    if (prediction.shouldSkip) {
      this.logger.warn('Skipping simulation due to high failure prediction', {
        taskId: prediction.taskId,
        confidence: prediction.confidence,
      });
      return false;
    }
    return true;
  }

  recordOutcome(taskId, contractId, success, gasUsed) {
    this.historyTracker.recordExecution(taskId, contractId, success, gasUsed);
  }

  getStats() {
    return {
      historySize: this.historyTracker.history.size,
      modelVersion: '1.0.0',
      confidenceThreshold: this.confidenceThreshold,
    };
  }
}

module.exports = {
  ExecutionHistoryTracker,
  MLExecutionFailurePredictor,
  CONFIDENCE_THRESHOLD,
  FEATURE_COUNT,
};
