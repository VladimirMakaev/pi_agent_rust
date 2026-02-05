/**
 * Daemon client for connecting to gob daemon via Unix socket.
 * Uses the newline-delimited JSON protocol defined in gob's daemon package.
 */
import type { Event, JobResponse, Response } from "./types.js";
export declare class DaemonClient {
    private socketPath;
    private subscriptionConn;
    private _connected;
    constructor();
    get connected(): boolean;
    /**
     * Probe the daemon socket and verify it's reachable.
     * Does NOT auto-start the daemon.
     * Returns true if daemon is running, false otherwise.
     */
    connect(): Promise<boolean>;
    /**
     * Send a request to the daemon over an ephemeral connection.
     */
    sendRequest(type: string, payload?: Record<string, unknown>): Promise<Response>;
    /**
     * List jobs, optionally filtered by workdir.
     */
    list(workdir?: string): Promise<JobResponse[]>;
    /**
     * Subscribe to daemon events. Returns an unsubscribe function.
     * The subscription uses a persistent connection that streams events.
     *
     * @param workdir - Filter events to jobs in this workdir
     * @param onEvent - Callback for each event
     * @param onError - Callback when the subscription disconnects
     */
    subscribe(workdir: string | undefined, onEvent: (event: Event) => void, onError: (err: Error) => void): () => void;
    /**
     * Close the subscription connection.
     */
    private closeSubscription;
    /**
     * Disconnect from the daemon, closing the subscription.
     */
    disconnect(): void;
}
//# sourceMappingURL=daemon-client.d.ts.map