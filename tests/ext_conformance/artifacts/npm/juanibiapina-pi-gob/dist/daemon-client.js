/**
 * Daemon client for connecting to gob daemon via Unix socket.
 * Uses the newline-delimited JSON protocol defined in gob's daemon package.
 */
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Get the gob daemon socket path.
 * Uses $XDG_RUNTIME_DIR/gob/daemon.sock if set.
 * Falls back to ~/Library/Application Support/gob/daemon.sock on macOS
 * (matching adrg/xdg Go library behavior).
 * Falls back to /run/user/<uid>/gob/daemon.sock on Linux.
 */
function getSocketPath() {
    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    if (xdgRuntime) {
        return path.join(xdgRuntime, "gob", "daemon.sock");
    }
    // macOS fallback — adrg/xdg uses ~/Library/Application Support as RuntimeDir
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "gob", "daemon.sock");
    }
    // Linux fallback if XDG_RUNTIME_DIR not set
    return path.join("/run/user", String(process.getuid?.()), "gob", "daemon.sock");
}
/**
 * Send a single request over a new ephemeral connection and return the response.
 * The daemon closes the connection after each response (except subscribe).
 */
async function sendEphemeralRequest(socketPath, req) {
    return new Promise((resolve, reject) => {
        const conn = net.createConnection(socketPath);
        let buffer = "";
        conn.on("connect", () => {
            conn.write(`${JSON.stringify(req)}\n`);
        });
        conn.on("data", (data) => {
            buffer += data.toString();
            const newlineIdx = buffer.indexOf("\n");
            if (newlineIdx !== -1) {
                const line = buffer.slice(0, newlineIdx);
                try {
                    const resp = JSON.parse(line);
                    conn.destroy();
                    resolve(resp);
                }
                catch (err) {
                    conn.destroy();
                    reject(new Error(`Failed to parse response: ${err}`));
                }
            }
        });
        conn.on("error", (err) => {
            reject(err);
        });
        conn.on("close", () => {
            if (buffer.trim()) {
                try {
                    resolve(JSON.parse(buffer.trim()));
                }
                catch {
                    reject(new Error("Connection closed before complete response"));
                }
            }
        });
        // Timeout after 5 seconds
        conn.setTimeout(5000, () => {
            conn.destroy();
            reject(new Error("Connection timed out"));
        });
    });
}
export class DaemonClient {
    socketPath;
    subscriptionConn = null;
    _connected = false;
    constructor() {
        this.socketPath = getSocketPath();
    }
    get connected() {
        return this._connected;
    }
    /**
     * Probe the daemon socket and verify it's reachable.
     * Does NOT auto-start the daemon.
     * Returns true if daemon is running, false otherwise.
     */
    async connect() {
        try {
            const resp = await sendEphemeralRequest(this.socketPath, {
                type: "version",
                payload: { client_version: "pi-extension" },
            });
            if (resp.success) {
                this._connected = true;
                return true;
            }
            return false;
        }
        catch {
            return false;
        }
    }
    /**
     * Send a request to the daemon over an ephemeral connection.
     */
    async sendRequest(type, payload) {
        const req = { type: type };
        if (payload) {
            req.payload = payload;
        }
        return sendEphemeralRequest(this.socketPath, req);
    }
    /**
     * List jobs, optionally filtered by workdir.
     */
    async list(workdir) {
        const payload = {};
        if (workdir) {
            payload.workdir = workdir;
        }
        const resp = await this.sendRequest("list", payload);
        if (!resp.success) {
            throw new Error(`list failed: ${resp.error}`);
        }
        const jobs = resp.data?.jobs;
        if (!jobs || !Array.isArray(jobs)) {
            return [];
        }
        return jobs;
    }
    /**
     * Subscribe to daemon events. Returns an unsubscribe function.
     * The subscription uses a persistent connection that streams events.
     *
     * @param workdir - Filter events to jobs in this workdir
     * @param onEvent - Callback for each event
     * @param onError - Callback when the subscription disconnects
     */
    subscribe(workdir, onEvent, onError) {
        // Close existing subscription if any
        this.closeSubscription();
        const conn = net.createConnection(this.socketPath);
        this.subscriptionConn = conn;
        let buffer = "";
        let gotInitialResponse = false;
        conn.on("connect", () => {
            const req = { type: "subscribe" };
            if (workdir) {
                req.payload = { workdir };
            }
            conn.write(`${JSON.stringify(req)}\n`);
        });
        conn.on("data", (data) => {
            buffer += data.toString();
            // Process all complete lines
            for (let newlineIdx = buffer.indexOf("\n"); newlineIdx !== -1; newlineIdx = buffer.indexOf("\n")) {
                const line = buffer.slice(0, newlineIdx);
                buffer = buffer.slice(newlineIdx + 1);
                if (!line.trim())
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    if (!gotInitialResponse) {
                        // First message is the subscribe response
                        gotInitialResponse = true;
                        if (!parsed.success) {
                            conn.destroy();
                            onError(new Error(`Subscribe failed: ${parsed.error}`));
                            return;
                        }
                        continue;
                    }
                    // Subsequent messages are events
                    onEvent(parsed);
                }
                catch {
                    // Skip malformed lines
                }
            }
        });
        conn.on("error", (err) => {
            this.subscriptionConn = null;
            onError(err);
        });
        conn.on("close", () => {
            const wasSubscription = this.subscriptionConn === conn;
            if (wasSubscription) {
                this.subscriptionConn = null;
                onError(new Error("Subscription connection closed"));
            }
        });
        // Return unsubscribe function
        return () => {
            if (this.subscriptionConn === conn) {
                this.closeSubscription();
            }
        };
    }
    /**
     * Close the subscription connection.
     */
    closeSubscription() {
        if (this.subscriptionConn) {
            this.subscriptionConn.destroy();
            this.subscriptionConn = null;
        }
    }
    /**
     * Disconnect from the daemon, closing the subscription.
     */
    disconnect() {
        this.closeSubscription();
        this._connected = false;
    }
}
//# sourceMappingURL=daemon-client.js.map