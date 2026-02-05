/**
 * Lightweight Linkup API client.
 */

const LINKUP_BASE_URL = "https://api.linkup.so";

/** Linkup fetch response */
export interface LinkupFetchResponse {
  markdown: string;
  rawHtml?: string;
  images?: LinkupImage[];
}

/** Linkup extracted image */
export interface LinkupImage {
  alt: string;
  url: string;
}

/** Linkup fetch options */
export interface LinkupFetchOptions {
  url: string;
  /** Render JavaScript on the page (default: false) */
  renderJs?: boolean;
  /** Include raw HTML in response (default: false) */
  includeRawHtml?: boolean;
  /** Extract images from the page (default: false) */
  extractImages?: boolean;
}

export class LinkupClient {
  private apiKey: string;

  constructor() {
    const apiKey = process.env.LINKUP_API_KEY;
    if (!apiKey) {
      throw new Error("LINKUP_API_KEY environment variable is not set");
    }
    this.apiKey = apiKey;
  }

  /** Fetch a URL and return markdown content */
  async fetch(
    options: LinkupFetchOptions,
    signal?: AbortSignal,
  ): Promise<LinkupFetchResponse> {
    const body = {
      url: options.url,
      renderJs: options.renderJs ?? false,
      includeRawHtml: options.includeRawHtml ?? false,
      extractImages: options.extractImages ?? false,
    };

    const response = await fetch(`${LINKUP_BASE_URL}/v1/fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Linkup API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<LinkupFetchResponse>;
  }
}

/** Create a Linkup client (throws if LINKUP_API_KEY not set) */
export function createLinkupClient(): LinkupClient {
  return new LinkupClient();
}
