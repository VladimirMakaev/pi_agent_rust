---
name: twinmind-reference-architecture
description: |
  Implement TwinMind reference architecture with best-practice project layout.
  Use when designing new TwinMind integrations, reviewing project structure,
  or establishing architecture standards for meeting AI applications.
  Trigger with phrases like "twinmind architecture", "twinmind best practices",
  "twinmind project structure", "how to organize twinmind", "twinmind layout".
allowed-tools: Read, Grep
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# TwinMind Reference Architecture

## Overview
Production-ready architecture patterns for TwinMind meeting AI integrations.

## Prerequisites
- Understanding of layered architecture
- TwinMind API knowledge
- TypeScript project setup
- Testing framework configured

## Project Structure

```
my-twinmind-project/
├── src/
│   ├── twinmind/
│   │   ├── client.ts           # Singleton client wrapper
│   │   ├── config.ts           # Environment configuration
│   │   ├── types.ts            # TypeScript types
│   │   ├── errors.ts           # Custom error classes
│   │   └── handlers/
│   │       ├── webhooks.ts     # Webhook handlers
│   │       └── events.ts       # Event processing
│   ├── services/
│   │   └── meeting/
│   │       ├── index.ts        # Service facade
│   │       ├── transcription.ts # Transcription service
│   │       ├── summary.ts      # Summary generation
│   │       ├── actions.ts      # Action item extraction
│   │       └── cache.ts        # Caching layer
│   ├── integrations/
│   │   ├── calendar/           # Calendar sync
│   │   ├── slack/              # Slack notifications
│   │   ├── linear/             # Task management
│   │   └── email/              # Follow-up emails
│   ├── api/
│   │   ├── routes/
│   │   │   ├── meetings.ts     # Meeting endpoints
│   │   │   ├── transcripts.ts  # Transcript endpoints
│   │   │   └── webhooks.ts     # Webhook endpoint
│   │   └── middleware/
│   │       ├── auth.ts         # Authentication
│   │       ├── rateLimit.ts    # Rate limiting
│   │       └── validation.ts   # Request validation
│   ├── jobs/
│   │   ├── sync.ts             # Background sync job
│   │   ├── cleanup.ts          # Data cleanup job
│   │   └── reports.ts          # Report generation
│   └── utils/
│       ├── audio.ts            # Audio processing
│       ├── logging.ts          # Structured logging
│       └── metrics.ts          # Prometheus metrics
├── tests/
│   ├── unit/
│   │   └── twinmind/
│   ├── integration/
│   │   └── twinmind/
│   └── e2e/
│       └── meeting-flow.test.ts
├── config/
│   ├── twinmind.development.json
│   ├── twinmind.staging.json
│   └── twinmind.production.json
└── docs/
    ├── ARCHITECTURE.md
    └── RUNBOOK.md
```

## Layer Architecture

```
┌─────────────────────────────────────────────────────┐
│                   API Layer                          │
│        (Controllers, Routes, Webhooks)               │
├─────────────────────────────────────────────────────┤
│                Service Layer                         │
│      (Business Logic, Orchestration)                 │
├─────────────────────────────────────────────────────┤
│              TwinMind Layer                          │
│       (Client, Types, Error Handling)                │
├─────────────────────────────────────────────────────┤
│             Integration Layer                        │
│    (Calendar, Slack, Linear, Email)                  │
├─────────────────────────────────────────────────────┤
│            Infrastructure Layer                      │
│       (Cache, Queue, Monitoring)                     │
└─────────────────────────────────────────────────────┘
```

## Key Components

### Step 1: Client Wrapper

```typescript
// src/twinmind/client.ts
import axios, { AxiosInstance } from 'axios';
import { TwinMindConfig, loadConfig } from './config';
import { TranscriptCache } from '../services/meeting/cache';
import { MetricsCollector } from '../utils/metrics';

export class TwinMindService {
  private client: AxiosInstance;
  private cache: TranscriptCache;
  private metrics: MetricsCollector;
  private config: TwinMindConfig;

  constructor(config?: TwinMindConfig) {
    this.config = config || loadConfig();

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: this.config.timeout,
    });

    this.cache = new TranscriptCache(this.config.cacheOptions);
    this.metrics = new MetricsCollector('twinmind');

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request logging
    this.client.interceptors.request.use((config) => {
      this.metrics.incrementCounter('requests', { method: config.method });
      return config;
    });

    // Response handling
    this.client.interceptors.response.use(
      (response) => {
        this.metrics.recordLatency(
          'request_duration',
          response.config.metadata?.startTime
        );
        return response;
      },
      (error) => {
        this.metrics.incrementCounter('errors', {
          status: error.response?.status || 'network',
        });
        throw error;
      }
    );
  }

  async transcribe(audioUrl: string, options?: TranscriptionOptions): Promise<Transcript> {
    return this.cache.getOrFetch(
      `transcript:${audioUrl}`,
      () => this.metrics.track(
        'transcribe',
        () => this.client.post('/transcribe', { audio_url: audioUrl, ...options })
      )
    );
  }

  async summarize(transcriptId: string): Promise<Summary> {
    return this.metrics.track(
      'summarize',
      () => this.client.post('/summarize', { transcript_id: transcriptId })
    );
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return this.client.get('/search', { params: { q: query, ...options } });
  }
}

// Singleton instance
let instance: TwinMindService | null = null;

export function getTwinMindService(): TwinMindService {
  if (!instance) {
    instance = new TwinMindService();
  }
  return instance;
}
```

### Step 2: Service Layer

```typescript
// src/services/meeting/index.ts
import { getTwinMindService } from '../../twinmind/client';
import { TranscriptionService } from './transcription';
import { SummaryService } from './summary';
import { ActionItemService } from './actions';
import { CalendarIntegration } from '../../integrations/calendar';
import { SlackIntegration } from '../../integrations/slack';

export interface MeetingResult {
  transcriptId: string;
  transcript: Transcript;
  summary: Summary;
  actionItems: ActionItem[];
  participants: Participant[];
}

export class MeetingService {
  private twinmind = getTwinMindService();
  private transcription = new TranscriptionService();
  private summaryService = new SummaryService();
  private actionService = new ActionItemService();
  private calendar = new CalendarIntegration();
  private slack = new SlackIntegration();

  async processMeeting(
    audioUrl: string,
    options: ProcessMeetingOptions = {}
  ): Promise<MeetingResult> {
    // Get calendar context
    const calendarEvent = options.calendarEventId
      ? await this.calendar.getEvent(options.calendarEventId)
      : null;

    // Transcribe
    const transcript = await this.transcription.transcribe(audioUrl, {
      title: calendarEvent?.title || options.title,
      attendees: calendarEvent?.attendees,
    });

    // Generate summary and extract action items in parallel
    const [summary, actionItems] = await Promise.all([
      this.summaryService.generate(transcript.id),
      this.actionService.extract(transcript.id),
    ]);

    // Identify participants
    const participants = await this.identifyParticipants(
      transcript,
      calendarEvent?.attendees
    );

    // Notify if configured
    if (options.notifySlack) {
      await this.slack.notifyMeetingComplete({
        title: transcript.title,
        summary: summary.summary,
        actionItems,
      });
    }

    return {
      transcriptId: transcript.id,
      transcript,
      summary,
      actionItems,
      participants,
    };
  }

  private async identifyParticipants(
    transcript: Transcript,
    attendees?: string[]
  ): Promise<Participant[]> {
    // Match speakers to attendees
    const speakers = transcript.speakers || [];

    return speakers.map((speaker, index) => ({
      id: speaker.id,
      name: attendees?.[index] || speaker.name || `Speaker ${index + 1}`,
      speakingTime: this.calculateSpeakingTime(transcript.segments, speaker.id),
    }));
  }

  private calculateSpeakingTime(segments: Segment[], speakerId: string): number {
    return segments
      .filter(s => s.speaker_id === speakerId)
      .reduce((total, s) => total + (s.end - s.start), 0);
  }
}
```

### Step 3: Error Boundary

```typescript
// src/twinmind/errors.ts
export class TwinMindError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'TwinMindError';
  }

  static fromApiError(error: any): TwinMindError {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    const code = error.response?.data?.code || 'UNKNOWN';

    switch (status) {
      case 401:
        return new TwinMindError(message, 'AUTH_FAILED', status, false);
      case 429:
        return new TwinMindError(message, 'RATE_LIMITED', status, true);
      case 500:
      case 502:
      case 503:
        return new TwinMindError(message, 'SERVER_ERROR', status, true);
      default:
        return new TwinMindError(message, code, status, false, error);
    }
  }
}

export function wrapWithErrorHandling<T>(
  operation: () => Promise<T>
): Promise<T> {
  return operation().catch((error) => {
    throw TwinMindError.fromApiError(error);
  });
}
```

### Step 4: Health Check

```typescript
// src/twinmind/health.ts
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
  timestamp: Date;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  latencyMs?: number;
  message?: string;
}

export async function checkHealth(): Promise<HealthStatus> {
  const checks: HealthCheck[] = [];

  // Check TwinMind API
  const apiCheck = await checkApiHealth();
  checks.push(apiCheck);

  // Check cache
  const cacheCheck = await checkCacheHealth();
  checks.push(cacheCheck);

  // Check database
  const dbCheck = await checkDatabaseHealth();
  checks.push(dbCheck);

  // Determine overall status
  const hasFailure = checks.some(c => c.status === 'fail');
  const hasWarning = checks.some(c => c.status === 'warn');

  return {
    status: hasFailure ? 'unhealthy' : hasWarning ? 'degraded' : 'healthy',
    checks,
    timestamp: new Date(),
  };
}

async function checkApiHealth(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const service = getTwinMindService();
    await service.healthCheck();
    return {
      name: 'twinmind_api',
      status: 'pass',
      latencyMs: Date.now() - start,
    };
  } catch (error: any) {
    return {
      name: 'twinmind_api',
      status: 'fail',
      latencyMs: Date.now() - start,
      message: error.message,
    };
  }
}
```

## Data Flow Diagram

```
                              ┌───────────────┐
                              │   Calendar    │
                              │   (Google)    │
                              └───────┬───────┘
                                      │ sync
┌──────────┐                 ┌────────▼────────┐
│  Client  │─────request────►│   API Gateway   │
│   App    │◄────response────│                 │
└──────────┘                 └────────┬────────┘
                                      │
                             ┌────────▼────────┐
                             │  Meeting        │
                             │  Service        │
                             └────────┬────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
     ┌────────▼────────┐    ┌────────▼────────┐    ┌────────▼────────┐
     │  Transcription  │    │    Summary      │    │  Action Items   │
     │    Service      │    │    Service      │    │    Service      │
     └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
              │                       │                       │
              └───────────────────────┼───────────────────────┘
                                      │
                             ┌────────▼────────┐
                             │   TwinMind      │
                             │     API         │
                             └────────┬────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
     ┌────────▼────────┐    ┌────────▼────────┐    ┌────────▼────────┐
     │     Slack       │    │     Linear      │    │     Email       │
     │  (notifications)│    │    (tasks)      │    │  (follow-ups)   │
     └─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Configuration Management

```typescript
// config/twinmind.ts
export interface TwinMindConfig {
  apiKey: string;
  baseUrl: string;
  environment: 'development' | 'staging' | 'production';
  timeout: number;
  retries: number;
  cacheOptions: {
    enabled: boolean;
    ttlSeconds: number;
  };
  features: {
    diarization: boolean;
    autoSummary: boolean;
    actionItemExtraction: boolean;
  };
}

export function loadConfig(): TwinMindConfig {
  const env = process.env.NODE_ENV || 'development';
  const envConfig = require(`./twinmind.${env}.json`);

  return {
    apiKey: process.env.TWINMIND_API_KEY!,
    baseUrl: process.env.TWINMIND_API_URL || 'https://api.twinmind.com/v1',
    environment: env as any,
    timeout: parseInt(process.env.TWINMIND_TIMEOUT || '30000'),
    retries: parseInt(process.env.TWINMIND_RETRIES || '3'),
    ...envConfig,
  };
}
```

## Output
- Structured project layout
- Client wrapper with caching and metrics
- Service layer with business logic
- Error boundary implemented
- Health checks configured
- Configuration management

## Error Handling

| Issue | Cause | Solution |
|-------|-------|----------|
| Circular dependencies | Wrong layering | Separate concerns by layer |
| Config not loading | Wrong paths | Verify config file locations |
| Type errors | Missing types | Add TwinMind types |
| Test isolation | Shared state | Use dependency injection |

## Resources
- [TwinMind API Reference](https://twinmind.com/docs/api)
- [Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- [TypeScript Best Practices](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html)

## Flagship Skills
For multi-environment setup, see `twinmind-multi-env-setup`.
