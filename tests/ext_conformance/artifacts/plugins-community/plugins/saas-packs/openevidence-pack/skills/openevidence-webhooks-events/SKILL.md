---
name: openevidence-webhooks-events
description: |
  Configure OpenEvidence webhooks for async DeepConsult completion and events.
  Use when implementing webhook handlers, configuring async notifications,
  or setting up event-driven clinical AI workflows.
  Trigger with phrases like "openevidence webhook", "openevidence events",
  "deepconsult callback", "openevidence notifications".
allowed-tools: Read, Write, Edit
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# OpenEvidence Webhooks & Events

## Overview
Configure webhooks for asynchronous OpenEvidence operations like DeepConsult completion notifications.

## Prerequisites
- OpenEvidence Enterprise account with webhook access
- HTTPS endpoint for receiving webhooks
- Webhook secret for signature verification
- Understanding of async processing patterns

## Webhook Events

| Event Type | Description | Payload |
|------------|-------------|---------|
| `deepconsult.started` | DeepConsult processing began | `consultId`, `estimatedTime` |
| `deepconsult.progress` | Processing progress update | `consultId`, `progress` (0-100) |
| `deepconsult.completed` | DeepConsult finished successfully | `consultId`, `report` |
| `deepconsult.failed` | DeepConsult processing failed | `consultId`, `error` |
| `rate_limit.warning` | Approaching rate limit | `remaining`, `limit`, `resetAt` |
| `api_key.expiring` | API key expiration warning | `keyId`, `expiresAt` |

## Instructions

### Step 1: Configure Webhook Endpoint
```typescript
// src/webhooks/openevidence-webhook.ts
import { Router, Request, Response } from 'express';
import crypto from 'crypto';

const router = Router();

// Webhook secret from OpenEvidence dashboard
const WEBHOOK_SECRET = process.env.OPENEVIDENCE_WEBHOOK_SECRET!;

interface WebhookPayload {
  id: string;
  event: string;
  timestamp: string;
  data: any;
}

// Signature verification middleware
function verifySignature(req: Request, res: Response, next: Function) {
  const signature = req.headers['x-openevidence-signature'] as string;

  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Parse signature: t=timestamp,v1=signature
  const parts = signature.split(',').reduce((acc, part) => {
    const [key, value] = part.split('=');
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>);

  const timestamp = parseInt(parts['t']);
  const providedSig = parts['v1'];

  // Reject if timestamp too old (5 minute tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return res.status(401).json({ error: 'Timestamp too old' });
  }

  // Compute expected signature
  const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  // Timing-safe comparison
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(providedSig),
      Buffer.from(expectedSig)
    );
    if (!valid) throw new Error('Invalid signature');
  } catch {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

router.post(
  '/webhooks/openevidence',
  verifySignature,
  async (req: Request, res: Response) => {
    const payload: WebhookPayload = req.body;

    console.log(`[Webhook] Received event: ${payload.event}`);

    try {
      await handleWebhookEvent(payload);
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error(`[Webhook] Processing failed:`, error);
      // Return 200 to prevent retries for processing errors
      // OpenEvidence will retry on 4xx/5xx
      res.status(200).json({ received: true, error: error.message });
    }
  }
);

export default router;
```

### Step 2: Event Handlers
```typescript
// src/webhooks/event-handlers.ts
import { WebhookPayload } from './types';
import { notificationService } from '../services/notifications';
import { db } from '../db';

export async function handleWebhookEvent(payload: WebhookPayload): Promise<void> {
  switch (payload.event) {
    case 'deepconsult.started':
      await handleDeepConsultStarted(payload);
      break;
    case 'deepconsult.progress':
      await handleDeepConsultProgress(payload);
      break;
    case 'deepconsult.completed':
      await handleDeepConsultCompleted(payload);
      break;
    case 'deepconsult.failed':
      await handleDeepConsultFailed(payload);
      break;
    case 'rate_limit.warning':
      await handleRateLimitWarning(payload);
      break;
    case 'api_key.expiring':
      await handleApiKeyExpiring(payload);
      break;
    default:
      console.log(`[Webhook] Unknown event type: ${payload.event}`);
  }
}

async function handleDeepConsultStarted(payload: WebhookPayload): Promise<void> {
  const { consultId, estimatedTime } = payload.data;

  await db.deepConsults.update({
    where: { consultId },
    data: {
      status: 'processing',
      estimatedCompletionAt: new Date(Date.now() + estimatedTime * 1000),
    },
  });
}

async function handleDeepConsultProgress(payload: WebhookPayload): Promise<void> {
  const { consultId, progress, currentPhase } = payload.data;

  await db.deepConsults.update({
    where: { consultId },
    data: {
      progress,
      currentPhase,
    },
  });

  // Notify user if subscribed to progress updates
  const consult = await db.deepConsults.findUnique({ where: { consultId } });
  if (consult?.notifyOnProgress) {
    await notificationService.sendProgress(consult.userId, consultId, progress);
  }
}

async function handleDeepConsultCompleted(payload: WebhookPayload): Promise<void> {
  const { consultId, report } = payload.data;

  // Store the report
  await db.deepConsults.update({
    where: { consultId },
    data: {
      status: 'completed',
      report,
      completedAt: new Date(),
    },
  });

  // Get user info
  const consult = await db.deepConsults.findUnique({
    where: { consultId },
    include: { user: true },
  });

  if (consult) {
    // Send notification
    await notificationService.send({
      userId: consult.userId,
      type: 'deepconsult_ready',
      title: 'DeepConsult Research Complete',
      body: `Your research synthesis for "${consult.question.substring(0, 50)}..." is ready.`,
      data: { consultId },
    });

    // Send email if enabled
    if (consult.user.emailNotifications) {
      await notificationService.sendEmail({
        to: consult.user.email,
        subject: 'Your OpenEvidence DeepConsult is Ready',
        template: 'deepconsult-complete',
        data: {
          userName: consult.user.name,
          consultId,
          summary: report.executiveSummary.substring(0, 200),
        },
      });
    }
  }
}

async function handleDeepConsultFailed(payload: WebhookPayload): Promise<void> {
  const { consultId, error, retryable } = payload.data;

  await db.deepConsults.update({
    where: { consultId },
    data: {
      status: 'failed',
      error,
      retryable,
    },
  });

  // Alert operations team
  await notificationService.alertOps({
    severity: 'warning',
    service: 'openevidence',
    message: `DeepConsult ${consultId} failed: ${error}`,
    retryable,
  });
}

async function handleRateLimitWarning(payload: WebhookPayload): Promise<void> {
  const { remaining, limit, resetAt } = payload.data;

  console.warn(`[RateLimit] Warning: ${remaining}/${limit} remaining, resets at ${resetAt}`);

  // Alert if critical
  if (remaining < limit * 0.1) {
    await notificationService.alertOps({
      severity: 'critical',
      service: 'openevidence',
      message: `Rate limit critical: ${remaining}/${limit} remaining`,
    });
  }
}

async function handleApiKeyExpiring(payload: WebhookPayload): Promise<void> {
  const { keyId, expiresAt } = payload.data;

  await notificationService.alertOps({
    severity: 'warning',
    service: 'openevidence',
    message: `API key ${keyId} expires at ${expiresAt}`,
    action: 'Rotate key before expiration',
  });
}
```

### Step 3: Webhook Registration
```typescript
// src/services/webhook-registration.ts
import { OpenEvidenceClient } from '@openevidence/sdk';

export async function registerWebhooks(): Promise<void> {
  const client = new OpenEvidenceClient({
    apiKey: process.env.OPENEVIDENCE_API_KEY!,
    orgId: process.env.OPENEVIDENCE_ORG_ID!,
  });

  const webhookUrl = process.env.WEBHOOK_BASE_URL + '/webhooks/openevidence';

  await client.webhooks.register({
    url: webhookUrl,
    events: [
      'deepconsult.started',
      'deepconsult.progress',
      'deepconsult.completed',
      'deepconsult.failed',
      'rate_limit.warning',
      'api_key.expiring',
    ],
    secret: process.env.OPENEVIDENCE_WEBHOOK_SECRET!,
  });

  console.log(`[Webhooks] Registered: ${webhookUrl}`);
}

// Call during app startup
registerWebhooks().catch(console.error);
```

### Step 4: Idempotency Handling
```typescript
// src/webhooks/idempotency.ts
import { db } from '../db';

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function isProcessed(webhookId: string): Promise<boolean> {
  const existing = await db.processedWebhooks.findUnique({
    where: { id: webhookId },
  });

  return !!existing;
}

export async function markProcessed(webhookId: string): Promise<void> {
  await db.processedWebhooks.create({
    data: {
      id: webhookId,
      processedAt: new Date(),
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL),
    },
  });
}

// Cleanup job
export async function cleanupExpiredWebhooks(): Promise<void> {
  await db.processedWebhooks.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
}

// Usage in webhook handler
async function handleWebhookWithIdempotency(payload: WebhookPayload): Promise<void> {
  if (await isProcessed(payload.id)) {
    console.log(`[Webhook] Already processed: ${payload.id}`);
    return;
  }

  await handleWebhookEvent(payload);
  await markProcessed(payload.id);
}
```

### Step 5: Webhook Testing
```typescript
// tests/webhooks/openevidence-webhook.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../../src/app';

const WEBHOOK_SECRET = 'test-secret';
process.env.OPENEVIDENCE_WEBHOOK_SECRET = WEBHOOK_SECRET;

function generateSignature(payload: object, timestamp: number): string {
  const payloadString = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadString}`;
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('OpenEvidence Webhooks', () => {
  it('should accept valid webhook', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      id: 'webhook-123',
      event: 'deepconsult.completed',
      timestamp: new Date().toISOString(),
      data: {
        consultId: 'consult-456',
        report: { executiveSummary: 'Test report' },
      },
    };

    const response = await request(app)
      .post('/webhooks/openevidence')
      .set('x-openevidence-signature', generateSignature(payload, timestamp))
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
  });

  it('should reject webhook with invalid signature', async () => {
    const payload = { event: 'test' };

    const response = await request(app)
      .post('/webhooks/openevidence')
      .set('x-openevidence-signature', 't=123,v1=invalid')
      .send(payload);

    expect(response.status).toBe(401);
  });

  it('should reject webhook with old timestamp', async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const payload = { event: 'test' };

    const response = await request(app)
      .post('/webhooks/openevidence')
      .set('x-openevidence-signature', generateSignature(payload, oldTimestamp))
      .send(payload);

    expect(response.status).toBe(401);
  });
});
```

## Output
- Secure webhook endpoint with signature verification
- Event handlers for all OpenEvidence events
- Idempotency protection
- Notification integration
- Comprehensive test coverage

## Webhook Security Checklist
- [ ] HTTPS endpoint only
- [ ] Signature verification enabled
- [ ] Timestamp validation (replay protection)
- [ ] Idempotency handling
- [ ] Secret rotation procedure documented

## Error Handling
| Webhook Issue | Detection | Resolution |
|---------------|-----------|------------|
| Invalid signature | 401 response | Check secret configuration |
| Missing events | No handler called | Verify webhook registration |
| Duplicate processing | Multiple notifications | Enable idempotency |
| Timeout | Webhook fails | Process async, return 200 quickly |

## Resources
- [OpenEvidence API Docs](https://docs.openevidence.com/)
- [Webhook Security Best Practices](https://webhooks.fyi/)

## Next Steps
For performance optimization, see `openevidence-performance-tuning`.
