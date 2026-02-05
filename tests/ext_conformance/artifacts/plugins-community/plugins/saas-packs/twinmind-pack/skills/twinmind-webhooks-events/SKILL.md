---
name: twinmind-webhooks-events
description: |
  Handle TwinMind webhooks and events for real-time meeting notifications.
  Use when implementing webhook handlers, processing meeting events,
  or building real-time integrations.
  Trigger with phrases like "twinmind webhooks", "twinmind events",
  "twinmind notifications", "meeting webhook handler".
allowed-tools: Read, Write, Edit, Bash(npm:*), Grep
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# TwinMind Webhooks & Events

## Overview
Implement webhook handlers for real-time TwinMind meeting events and notifications.

## Prerequisites
- TwinMind Pro/Enterprise account
- Public HTTPS endpoint for webhooks
- Webhook secret configured
- Understanding of event-driven architecture

## Instructions

### Step 1: Define Event Types

```typescript
// src/twinmind/events/types.ts
export enum TwinMindEventType {
  // Transcription events
  TRANSCRIPTION_STARTED = 'transcription.started',
  TRANSCRIPTION_COMPLETED = 'transcription.completed',
  TRANSCRIPTION_FAILED = 'transcription.failed',

  // Meeting events
  MEETING_STARTED = 'meeting.started',
  MEETING_ENDED = 'meeting.ended',
  MEETING_PARTICIPANT_JOINED = 'meeting.participant.joined',
  MEETING_PARTICIPANT_LEFT = 'meeting.participant.left',

  // Summary events
  SUMMARY_GENERATED = 'summary.generated',
  ACTION_ITEMS_EXTRACTED = 'action_items.extracted',

  // Calendar events
  CALENDAR_SYNCED = 'calendar.synced',
  CALENDAR_EVENT_REMINDER = 'calendar.event.reminder',

  // Account events
  USAGE_LIMIT_WARNING = 'usage.limit.warning',
  USAGE_LIMIT_EXCEEDED = 'usage.limit.exceeded',
}

export interface TwinMindEvent<T = any> {
  id: string;
  type: TwinMindEventType;
  created_at: string;
  data: T;
}

export interface TranscriptionCompletedData {
  transcript_id: string;
  duration_seconds: number;
  language: string;
  word_count: number;
  speaker_count: number;
  model: string;
}

export interface MeetingEndedData {
  meeting_id: string;
  transcript_id: string;
  title: string;
  duration_seconds: number;
  participants: string[];
  summary_available: boolean;
}

export interface SummaryGeneratedData {
  summary_id: string;
  transcript_id: string;
  action_item_count: number;
  key_point_count: number;
}

export interface ActionItemsExtractedData {
  transcript_id: string;
  action_items: Array<{
    text: string;
    assignee?: string;
    due_date?: string;
  }>;
}
```

### Step 2: Implement Webhook Handler

```typescript
// src/twinmind/webhooks/handler.ts
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { TwinMindEvent, TwinMindEventType } from '../events/types';

// Signature verification middleware
export function verifySignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signature = req.headers['x-twinmind-signature'] as string;
  const timestamp = req.headers['x-twinmind-timestamp'] as string;
  const secret = process.env.TWINMIND_WEBHOOK_SECRET!;

  if (!signature || !timestamp) {
    res.status(401).json({ error: 'Missing signature or timestamp' });
    return;
  }

  // Check timestamp to prevent replay attacks (5 minute window)
  const timestampMs = parseInt(timestamp) * 1000;
  const now = Date.now();
  if (Math.abs(now - timestampMs) > 5 * 60 * 1000) {
    res.status(401).json({ error: 'Request too old' });
    return;
  }

  // Verify signature
  const payload = `${timestamp}.${JSON.stringify(req.body)}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  if (!crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expectedSignature}`)
  )) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}

// Event handlers registry
type EventHandler<T = any> = (event: TwinMindEvent<T>) => Promise<void>;

const handlers = new Map<TwinMindEventType, EventHandler[]>();

export function registerHandler<T>(
  eventType: TwinMindEventType,
  handler: EventHandler<T>
): void {
  const existing = handlers.get(eventType) || [];
  existing.push(handler);
  handlers.set(eventType, existing);
}

// Main webhook route handler
export async function handleWebhook(
  req: Request,
  res: Response
): Promise<void> {
  const event = req.body as TwinMindEvent;

  console.log(`Received event: ${event.type} (${event.id})`);

  // Acknowledge receipt immediately
  res.status(200).json({ received: true, event_id: event.id });

  // Process event asynchronously
  try {
    const eventHandlers = handlers.get(event.type as TwinMindEventType);

    if (eventHandlers && eventHandlers.length > 0) {
      await Promise.all(
        eventHandlers.map(handler => handler(event))
      );
    } else {
      console.log(`No handlers registered for event type: ${event.type}`);
    }
  } catch (error) {
    console.error(`Error processing event ${event.id}:`, error);
    // Don't throw - we already acknowledged receipt
  }
}
```

### Step 3: Implement Event Handlers

```typescript
// src/twinmind/webhooks/event-handlers.ts
import {
  TwinMindEvent,
  TwinMindEventType,
  TranscriptionCompletedData,
  MeetingEndedData,
  SummaryGeneratedData,
  ActionItemsExtractedData,
} from '../events/types';
import { registerHandler } from './handler';
import { notifySlack, sendEmail } from '../notifications';
import { createTasksInLinear } from '../integrations/linear';

// Handle transcription completed
registerHandler<TranscriptionCompletedData>(
  TwinMindEventType.TRANSCRIPTION_COMPLETED,
  async (event) => {
    const { transcript_id, duration_seconds, word_count, speaker_count } = event.data;

    console.log(`Transcription completed: ${transcript_id}`);
    console.log(`  Duration: ${duration_seconds}s`);
    console.log(`  Words: ${word_count}`);
    console.log(`  Speakers: ${speaker_count}`);

    // Trigger summary generation
    const client = getTwinMindClient();
    await client.post('/summarize', { transcript_id });
  }
);

// Handle meeting ended
registerHandler<MeetingEndedData>(
  TwinMindEventType.MEETING_ENDED,
  async (event) => {
    const { meeting_id, title, duration_seconds, participants, summary_available } = event.data;

    console.log(`Meeting ended: ${title} (${meeting_id})`);

    // Notify participants
    await notifySlack({
      channel: '#meetings',
      message: `Meeting "${title}" has ended (${Math.round(duration_seconds / 60)} minutes)`,
      participants,
    });

    // If summary is ready, send it
    if (summary_available) {
      const client = getTwinMindClient();
      const summary = await client.get(`/summaries/${event.data.transcript_id}`);

      await sendEmail({
        to: participants,
        subject: `Meeting Summary: ${title}`,
        body: summary.data.summary,
      });
    }
  }
);

// Handle summary generated
registerHandler<SummaryGeneratedData>(
  TwinMindEventType.SUMMARY_GENERATED,
  async (event) => {
    const { summary_id, transcript_id, action_item_count } = event.data;

    console.log(`Summary generated: ${summary_id}`);
    console.log(`  Action items: ${action_item_count}`);

    // Store summary in database
    await db.summaries.create({
      id: summary_id,
      transcript_id,
      created_at: new Date(event.created_at),
    });
  }
);

// Handle action items extracted
registerHandler<ActionItemsExtractedData>(
  TwinMindEventType.ACTION_ITEMS_EXTRACTED,
  async (event) => {
    const { transcript_id, action_items } = event.data;

    console.log(`Action items extracted: ${action_items.length}`);

    // Create tasks in project management tool
    if (action_items.length > 0) {
      await createTasksInLinear(action_items);
    }
  }
);

// Handle usage warning
registerHandler(
  TwinMindEventType.USAGE_LIMIT_WARNING,
  async (event) => {
    console.warn('Usage limit warning:', event.data);

    await notifySlack({
      channel: '#alerts',
      message: `:warning: TwinMind usage at ${event.data.percent_used}% of limit`,
    });
  }
);
```

### Step 4: Set Up Webhook Endpoint

```typescript
// src/api/webhooks/twinmind.ts
import express from 'express';
import { verifySignature, handleWebhook } from '../../twinmind/webhooks/handler';

const router = express.Router();

// Raw body parser for signature verification
router.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));

// Webhook endpoint
router.post(
  '/twinmind',
  verifySignature,
  handleWebhook
);

export default router;
```

### Step 5: Register Webhooks

```typescript
// scripts/register-webhooks.ts
import { getTwinMindClient } from '../src/twinmind/client';
import { TwinMindEventType } from '../src/twinmind/events/types';

async function registerWebhooks() {
  const client = getTwinMindClient();

  const webhookUrl = process.env.WEBHOOK_BASE_URL + '/webhooks/twinmind';

  // Register webhook
  const response = await client.post('/webhooks', {
    url: webhookUrl,
    events: [
      TwinMindEventType.TRANSCRIPTION_COMPLETED,
      TwinMindEventType.MEETING_ENDED,
      TwinMindEventType.SUMMARY_GENERATED,
      TwinMindEventType.ACTION_ITEMS_EXTRACTED,
      TwinMindEventType.USAGE_LIMIT_WARNING,
    ],
    enabled: true,
  });

  console.log('Webhook registered:', response.data);

  // Generate and store webhook secret
  console.log('Webhook Secret:', response.data.secret);
  console.log('Add to .env: TWINMIND_WEBHOOK_SECRET=' + response.data.secret);
}

registerWebhooks();
```

### Step 6: Implement Retry Logic for Failed Events

```typescript
// src/twinmind/webhooks/retry.ts
import { TwinMindEvent } from '../events/types';

interface FailedEvent {
  event: TwinMindEvent;
  attempts: number;
  lastError: string;
  nextRetry: Date;
}

class WebhookRetryQueue {
  private queue: FailedEvent[] = [];
  private maxRetries = 5;
  private baseDelayMs = 60000; // 1 minute

  async add(event: TwinMindEvent, error: Error): Promise<void> {
    const existing = this.queue.find(f => f.event.id === event.id);

    if (existing) {
      existing.attempts += 1;
      existing.lastError = error.message;
      existing.nextRetry = new Date(
        Date.now() + this.baseDelayMs * Math.pow(2, existing.attempts)
      );

      if (existing.attempts >= this.maxRetries) {
        // Move to dead letter queue
        await this.moveToDeadLetter(existing);
        this.queue = this.queue.filter(f => f.event.id !== event.id);
      }
    } else {
      this.queue.push({
        event,
        attempts: 1,
        lastError: error.message,
        nextRetry: new Date(Date.now() + this.baseDelayMs),
      });
    }
  }

  async processRetries(): Promise<void> {
    const now = new Date();
    const readyEvents = this.queue.filter(f => f.nextRetry <= now);

    for (const failedEvent of readyEvents) {
      try {
        await this.reprocessEvent(failedEvent.event);
        this.queue = this.queue.filter(f => f.event.id !== failedEvent.event.id);
        console.log(`Successfully reprocessed event: ${failedEvent.event.id}`);
      } catch (error: any) {
        await this.add(failedEvent.event, error);
      }
    }
  }

  private async reprocessEvent(event: TwinMindEvent): Promise<void> {
    // Re-dispatch to handlers
    const handlers = getHandlersForEvent(event.type);
    await Promise.all(handlers.map(h => h(event)));
  }

  private async moveToDeadLetter(failedEvent: FailedEvent): Promise<void> {
    console.error(`Event ${failedEvent.event.id} moved to dead letter queue after ${failedEvent.attempts} attempts`);

    // Store in database for manual review
    await db.deadLetterQueue.create({
      event_id: failedEvent.event.id,
      event_type: failedEvent.event.type,
      payload: failedEvent.event,
      attempts: failedEvent.attempts,
      last_error: failedEvent.lastError,
    });

    // Alert ops team
    await notifySlack({
      channel: '#alerts',
      message: `:x: Webhook event failed after ${failedEvent.attempts} attempts: ${failedEvent.event.id}`,
    });
  }
}

export const retryQueue = new WebhookRetryQueue();

// Start retry processor
setInterval(() => retryQueue.processRetries(), 60000);
```

## Output
- Event type definitions
- Webhook handler with signature verification
- Event processing logic
- Webhook registration script
- Retry queue for failed events

## Webhook Events Reference

| Event | Description | Data |
|-------|-------------|------|
| `transcription.started` | Transcription job started | `transcript_id`, `audio_url` |
| `transcription.completed` | Transcription finished | `transcript_id`, `duration`, `word_count` |
| `transcription.failed` | Transcription failed | `transcript_id`, `error` |
| `meeting.started` | Live meeting capture started | `meeting_id`, `title` |
| `meeting.ended` | Meeting finished | `meeting_id`, `transcript_id`, `participants` |
| `summary.generated` | AI summary ready | `summary_id`, `action_item_count` |
| `action_items.extracted` | Action items available | `transcript_id`, `action_items[]` |
| `usage.limit.warning` | Usage approaching limit | `percent_used`, `limit` |

## Error Handling

| Issue | Cause | Solution |
|-------|-------|----------|
| Invalid signature | Wrong secret | Verify webhook secret |
| Event missed | Endpoint down | Implement retry queue |
| Processing slow | Heavy handler | Use async queue |
| Duplicate events | Retries | Implement idempotency |

## Resources
- [TwinMind Webhooks API](https://twinmind.com/docs/webhooks)
- [Webhook Best Practices](https://twinmind.com/docs/webhook-best-practices)
- [Event Reference](https://twinmind.com/docs/events)

## Next Steps
For performance optimization, see `twinmind-performance-tuning`.
