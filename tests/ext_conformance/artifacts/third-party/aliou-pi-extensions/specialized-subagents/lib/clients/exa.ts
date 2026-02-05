/**
 * Lightweight Exa API client.
 */

const EXA_BASE_URL = "https://api.exa.ai";

/** Exa search result */
export interface ExaSearchResult {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  summary?: string;
  highlights?: string[];
}

/** Exa search response */
export interface ExaSearchResponse {
  requestId: string;
  results: ExaSearchResult[];
  costDollars?: { total: number };
}

/** Exa contents result */
export interface ExaContentsResult {
  title: string;
  url: string;
  text?: string;
  summary?: string;
  publishedDate?: string;
  author?: string;
}

/**
 * Exa URL status (from contents endpoint).
 *
 * Error tags:
 * - CRAWL_NOT_FOUND (404): Content not found at URL
 * - CRAWL_TIMEOUT (408): Request timed out
 * - CRAWL_LIVECRAWL_TIMEOUT (408): Live crawl timed out
 * - SOURCE_NOT_AVAILABLE (403): Access forbidden or behind paywall
 * - CRAWL_UNKNOWN_ERROR (500+): Other crawling errors
 */
export interface ExaUrlStatus {
  id: string;
  status: "success" | "error";
  error?: {
    httpStatusCode?: number;
    tag?:
      | "CRAWL_NOT_FOUND"
      | "CRAWL_TIMEOUT"
      | "CRAWL_LIVECRAWL_TIMEOUT"
      | "SOURCE_NOT_AVAILABLE"
      | "CRAWL_UNKNOWN_ERROR";
  };
}

/** Exa contents response */
export interface ExaContentsResponse {
  requestId: string;
  results: ExaContentsResult[];
  statuses?: ExaUrlStatus[];
  costDollars?: { total: number };
}

/** Exa search options */
export interface ExaSearchOptions {
  query: string;
  numResults?: number;
  includeText?: boolean;
  includeSummary?: boolean;
  maxTextCharacters?: number;
}

/** Exa contents options */
export interface ExaContentsOptions {
  urls: string[];
  includeText?: boolean;
  livecrawl?: "never" | "fallback" | "preferred" | "always";
}

export class ExaClient {
  private apiKey: string;

  constructor() {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      throw new Error("EXA_API_KEY environment variable is not set");
    }
    this.apiKey = apiKey;
  }

  private async request<T>(
    endpoint: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${EXA_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Exa API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /** Search the web */
  async search(
    options: ExaSearchOptions,
    signal?: AbortSignal,
  ): Promise<ExaSearchResponse> {
    const body: Record<string, unknown> = {
      query: options.query,
      numResults: options.numResults ?? 10,
    };

    // Add contents options if text or summary requested
    if (options.includeText || options.includeSummary) {
      const contents: Record<string, unknown> = {};
      if (options.includeText) {
        contents.text = options.maxTextCharacters
          ? { maxCharacters: options.maxTextCharacters }
          : true;
      }
      if (options.includeSummary) {
        contents.summary = {};
      }
      body.contents = contents;
    }

    return this.request<ExaSearchResponse>("/search", body, signal);
  }

  /** Get contents of URLs */
  async contents(
    options: ExaContentsOptions,
    signal?: AbortSignal,
  ): Promise<ExaContentsResponse> {
    const body: Record<string, unknown> = {
      urls: options.urls,
      text: options.includeText ?? true,
      livecrawl: options.livecrawl ?? "fallback",
    };

    return this.request<ExaContentsResponse>("/contents", body, signal);
  }
}

/** Create an Exa client (throws if EXA_API_KEY not set) */
export function createExaClient(): ExaClient {
  return new ExaClient();
}
