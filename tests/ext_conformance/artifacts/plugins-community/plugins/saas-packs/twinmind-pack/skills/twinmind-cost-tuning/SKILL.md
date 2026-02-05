---
name: twinmind-cost-tuning
description: |
  Optimize TwinMind costs across Free, Pro, and Enterprise tiers.
  Use when analyzing usage patterns, reducing costs,
  or choosing the right pricing tier for your needs.
  Trigger with phrases like "twinmind cost", "reduce twinmind spending",
  "twinmind pricing optimization", "twinmind budget".
allowed-tools: Read, Write, Edit
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# TwinMind Cost Tuning

## Overview
Optimize TwinMind costs through usage analysis, tier selection, and efficiency improvements.

## Prerequisites
- TwinMind account with billing access
- Understanding of usage patterns
- Access to usage analytics

## Instructions

### Step 1: Understand Pricing Structure

```typescript
// src/twinmind/costs/pricing.ts
export interface TierPricing {
  name: string;
  monthlyBase: number;          // Base subscription cost
  transcriptionRate: number;    // Per hour of audio
  apiRequestRate: number;       // Per 1000 requests
  aiTokenRate: number;          // Per 1M tokens
  storageRate: number;          // Per GB per month
  includedHours: number;        // Included transcription hours
  includedTokens: number;       // Included AI tokens
}

export const pricingTiers: Record<string, TierPricing> = {
  free: {
    name: 'Free',
    monthlyBase: 0,
    transcriptionRate: 0,        // Unlimited but basic quality
    apiRequestRate: 0,           // No API access
    aiTokenRate: 0,
    storageRate: 0,
    includedHours: Infinity,     // Unlimited
    includedTokens: 500000,
  },
  pro: {
    name: 'Pro',
    monthlyBase: 10,
    transcriptionRate: 0.23,     // $0.23 per hour (Ear-3)
    apiRequestRate: 0,           // Included
    aiTokenRate: 0,              // Included up to limit
    storageRate: 0,
    includedHours: Infinity,     // Unlimited
    includedTokens: 2000000,
  },
  enterprise: {
    name: 'Enterprise',
    monthlyBase: 0,              // Custom pricing
    transcriptionRate: 0.15,     // Volume discount
    apiRequestRate: 0,
    aiTokenRate: 0,
    storageRate: 0,
    includedHours: Infinity,
    includedTokens: Infinity,
  },
};
```

### Step 2: Analyze Current Usage

```typescript
// src/twinmind/costs/analyzer.ts
export interface UsageData {
  period: string;
  transcriptionHours: number;
  apiRequests: number;
  aiTokensUsed: number;
  storageGB: number;
  meetings: number;
}

export interface CostAnalysis {
  currentTier: string;
  currentCost: number;
  estimatedCostPerTier: Record<string, number>;
  recommendedTier: string;
  potentialSavings: number;
  breakdown: CostBreakdown;
}

export interface CostBreakdown {
  base: number;
  transcription: number;
  api: number;
  aiTokens: number;
  storage: number;
  total: number;
}

export async function analyzeUsage(): Promise<CostAnalysis> {
  const client = getTwinMindClient();

  // Get last 30 days usage
  const usage = await client.get('/usage', {
    params: { period: 'last_30_days' },
  });

  const data: UsageData = usage.data;
  const currentTier = (await client.get('/account')).data.plan;

  // Calculate cost for each tier
  const costByTier: Record<string, number> = {};

  for (const [tierName, tier] of Object.entries(pricingTiers)) {
    const cost = calculateTierCost(tier, data);
    costByTier[tierName] = cost;
  }

  // Find recommended tier
  const validTiers = Object.entries(costByTier)
    .filter(([tier]) => meetsRequirements(tier, data))
    .sort(([, a], [, b]) => a - b);

  const recommendedTier = validTiers[0]?.[0] || 'pro';
  const currentCost = costByTier[currentTier];
  const recommendedCost = costByTier[recommendedTier];

  return {
    currentTier,
    currentCost,
    estimatedCostPerTier: costByTier,
    recommendedTier,
    potentialSavings: currentCost - recommendedCost,
    breakdown: calculateBreakdown(pricingTiers[currentTier], data),
  };
}

function calculateTierCost(tier: TierPricing, usage: UsageData): number {
  let cost = tier.monthlyBase;

  // Transcription cost (if over included)
  if (usage.transcriptionHours > tier.includedHours) {
    cost += (usage.transcriptionHours - tier.includedHours) * tier.transcriptionRate;
  }

  // AI tokens (if over included)
  if (usage.aiTokensUsed > tier.includedTokens) {
    const overageTokens = usage.aiTokensUsed - tier.includedTokens;
    cost += (overageTokens / 1000000) * tier.aiTokenRate;
  }

  return cost;
}

function meetsRequirements(tier: string, usage: UsageData): boolean {
  // Free tier doesn't have API access
  if (tier === 'free' && usage.apiRequests > 0) {
    return false;
  }
  return true;
}
```

### Step 3: Implement Cost Monitoring

```typescript
// src/twinmind/costs/monitor.ts
export interface CostAlert {
  type: 'warning' | 'critical';
  message: string;
  currentSpend: number;
  threshold: number;
  percentUsed: number;
}

export interface BudgetConfig {
  monthlyBudget: number;
  warningThreshold: number;  // e.g., 0.8 for 80%
  criticalThreshold: number; // e.g., 0.95 for 95%
  notifications: {
    email?: string[];
    slack?: string;
    webhook?: string;
  };
}

export class CostMonitor {
  private config: BudgetConfig;

  constructor(config: BudgetConfig) {
    this.config = config;
  }

  async checkBudget(): Promise<CostAlert | null> {
    const client = getTwinMindClient();
    const usage = await client.get('/usage/cost', {
      params: { period: 'current_month' },
    });

    const currentSpend = usage.data.total_cost;
    const percentUsed = currentSpend / this.config.monthlyBudget;

    if (percentUsed >= this.config.criticalThreshold) {
      return {
        type: 'critical',
        message: `TwinMind spending at ${(percentUsed * 100).toFixed(1)}% of monthly budget`,
        currentSpend,
        threshold: this.config.monthlyBudget,
        percentUsed,
      };
    }

    if (percentUsed >= this.config.warningThreshold) {
      return {
        type: 'warning',
        message: `TwinMind spending at ${(percentUsed * 100).toFixed(1)}% of monthly budget`,
        currentSpend,
        threshold: this.config.monthlyBudget,
        percentUsed,
      };
    }

    return null;
  }

  async sendAlert(alert: CostAlert): Promise<void> {
    const { notifications } = this.config;

    if (notifications.slack) {
      await sendSlackNotification(notifications.slack, {
        text: `:${alert.type === 'critical' ? 'rotating_light' : 'warning'}: ${alert.message}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*TwinMind Budget Alert*\n${alert.message}\n\nCurrent: $${alert.currentSpend.toFixed(2)} / $${alert.threshold.toFixed(2)}`,
            },
          },
        ],
      });
    }

    if (notifications.email) {
      await sendEmail({
        to: notifications.email,
        subject: `[${alert.type.toUpperCase()}] TwinMind Budget Alert`,
        body: `${alert.message}\n\nCurrent spend: $${alert.currentSpend.toFixed(2)}\nBudget: $${alert.threshold.toFixed(2)}\nUsed: ${(alert.percentUsed * 100).toFixed(1)}%`,
      });
    }
  }
}

// Schedule budget checks
export function startCostMonitoring(config: BudgetConfig): void {
  const monitor = new CostMonitor(config);

  // Check every hour
  setInterval(async () => {
    const alert = await monitor.checkBudget();
    if (alert) {
      await monitor.sendAlert(alert);
    }
  }, 60 * 60 * 1000);
}
```

### Step 4: Optimize Token Usage

```typescript
// src/twinmind/costs/token-optimization.ts
export interface TokenUsageReport {
  totalTokens: number;
  byFeature: Record<string, number>;
  optimizationPotential: number;
  recommendations: string[];
}

export async function analyzeTokenUsage(): Promise<TokenUsageReport> {
  const client = getTwinMindClient();
  const usage = await client.get('/usage/tokens', {
    params: { period: 'last_30_days', breakdown: 'by_feature' },
  });

  const byFeature = usage.data.breakdown;
  const totalTokens = Object.values(byFeature).reduce((sum: number, v) => sum + (v as number), 0);

  const recommendations: string[] = [];
  let optimizationPotential = 0;

  // Check for optimization opportunities
  if (byFeature.summary > totalTokens * 0.5) {
    recommendations.push('High summary token usage - consider using shorter summaries');
    optimizationPotential += byFeature.summary * 0.3;
  }

  if (byFeature.chat > totalTokens * 0.3) {
    recommendations.push('High chat token usage - implement response caching');
    optimizationPotential += byFeature.chat * 0.2;
  }

  if (byFeature.memory_search > totalTokens * 0.2) {
    recommendations.push('Consider indexing optimization for memory searches');
    optimizationPotential += byFeature.memory_search * 0.1;
  }

  return {
    totalTokens,
    byFeature,
    optimizationPotential,
    recommendations,
  };
}

// Token-efficient summary options
export const tokenEfficientOptions = {
  summary: {
    brief: {
      maxLength: 150,          // Short summary
      includeActionItems: true,
      includeKeyPoints: false,
      estimatedTokens: 200,
    },
    standard: {
      maxLength: 300,
      includeActionItems: true,
      includeKeyPoints: true,
      estimatedTokens: 500,
    },
    detailed: {
      maxLength: 500,
      includeActionItems: true,
      includeKeyPoints: true,
      estimatedTokens: 800,
    },
  },
};
```

### Step 5: Implement Usage Quotas

```typescript
// src/twinmind/costs/quotas.ts
export interface QuotaConfig {
  dailyTranscriptionHours: number;
  dailyApiRequests: number;
  dailyAiTokens: number;
}

export class QuotaManager {
  private config: QuotaConfig;
  private usage = {
    transcriptionHours: 0,
    apiRequests: 0,
    aiTokens: 0,
    lastReset: new Date(),
  };

  constructor(config: QuotaConfig) {
    this.config = config;
    this.startDailyReset();
  }

  private startDailyReset(): void {
    // Reset at midnight
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);

    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
      this.resetUsage();
      setInterval(() => this.resetUsage(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  private resetUsage(): void {
    this.usage = {
      transcriptionHours: 0,
      apiRequests: 0,
      aiTokens: 0,
      lastReset: new Date(),
    };
  }

  canTranscribe(hours: number): boolean {
    return this.usage.transcriptionHours + hours <= this.config.dailyTranscriptionHours;
  }

  canMakeApiRequest(): boolean {
    return this.usage.apiRequests < this.config.dailyApiRequests;
  }

  canUseTokens(tokens: number): boolean {
    return this.usage.aiTokens + tokens <= this.config.dailyAiTokens;
  }

  recordUsage(type: 'transcription' | 'api' | 'tokens', amount: number): void {
    switch (type) {
      case 'transcription':
        this.usage.transcriptionHours += amount;
        break;
      case 'api':
        this.usage.apiRequests += amount;
        break;
      case 'tokens':
        this.usage.aiTokens += amount;
        break;
    }
  }

  getRemainingQuota(): {
    transcriptionHours: number;
    apiRequests: number;
    aiTokens: number;
  } {
    return {
      transcriptionHours: Math.max(0, this.config.dailyTranscriptionHours - this.usage.transcriptionHours),
      apiRequests: Math.max(0, this.config.dailyApiRequests - this.usage.apiRequests),
      aiTokens: Math.max(0, this.config.dailyAiTokens - this.usage.aiTokens),
    };
  }
}

// Usage with middleware
export function quotaMiddleware(quotaManager: QuotaManager) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!quotaManager.canMakeApiRequest()) {
      return res.status(429).json({
        error: 'Daily API quota exceeded',
        remaining: quotaManager.getRemainingQuota(),
      });
    }

    quotaManager.recordUsage('api', 1);
    next();
  };
}
```

## Output
- Pricing structure analysis
- Usage cost analyzer
- Budget monitoring system
- Token optimization strategies
- Quota management

## Cost Optimization Strategies

| Strategy | Savings | Implementation |
|----------|---------|----------------|
| Use brief summaries | 30-50% tokens | Set maxLength: 150 |
| Cache memory searches | 20-30% | Implement result caching |
| Batch transcriptions | 10-15% | Group small files |
| Off-peak processing | 0% (no TwinMind variation) | N/A |
| Annual billing | 33% | Switch to annual plan |

## Pricing Comparison

| Feature | Free | Pro ($10/mo) | Enterprise |
|---------|------|--------------|------------|
| Transcription | Unlimited | Unlimited | Unlimited |
| API Access | No | Yes | Yes |
| Ear-3 Model | No | Yes | Yes |
| Context Tokens | 500K | 2M | Unlimited |
| Rate Limits | 30/min | 60/min | 300/min |
| Support | Community | 24hr | Dedicated |
| Cost/Hour | $0 | $0.23 | Custom |

## Error Handling

| Issue | Cause | Solution |
|-------|-------|----------|
| Unexpected charges | Usage spike | Set up budget alerts |
| Quota exceeded | High usage | Implement rate limiting |
| Wrong tier | Poor planning | Analyze usage patterns |

## Resources
- [TwinMind Pricing](https://twinmind.com/pricing)
- [Usage Dashboard](https://twinmind.com/settings/usage)
- [Enterprise Plans](https://twinmind.com/enterprise)

## Next Steps
For reference architecture, see `twinmind-reference-architecture`.
