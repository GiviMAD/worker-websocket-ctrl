import * as Comlink from 'comlink';
interface WorkerWebSocketCtrl {
    /**
     * Listen ws messages.
     */
    onEvent: (ev: string) => void;
    /**
     * Ping pong with main thread.
     */
    ping: (pong: () => void) => void;
    /**
     * Listen websocket connection/reconnection.
     */
    onConnect?: () => void;
    /**
    * Listen websocket connection/reconnection.
    */
    onDisconnect?: () => void;
    /**
     * Called once when health check fails for this subscription meaning 
     * it has been removed and no events will be send to it.
     */
    onClose?: () => void;
}
let ws = null as WebSocket | null;
let subscribers = new Set<WorkerWebSocketCtrl>();
let _getProtocols: ((path: string) => Promise<string[] | null>) | null = null;
const DEFAULT_KEEPALIVE_INTERVAL_SEG = 30;
const DEFAULT_KEEPALIVE_TIMEOUT_SEG = 5;
const DEFAULT_RECONNECT_SEG = 5;
export interface WorkerWsCtrlOptions {
    keepaliveInterval?: number
    keepaliveTimeout?: number
    reconnectDelay?: number
    closeDelay?: number
}
export class WorkerWsController {
    private apiUrl = '';
    private apiUrlToJoin: string = '';
    private reconnectRef: any;
    private closeRef: any;
    private keepAliveInterval: number;
    private keepAliveTimeout: number;
    private reconnectDelay: number;
    private closeDelay: number;
    constructor(private workerCtx: Window, public path: string, private options: WorkerWsCtrlOptions = {}) {
        if (path.startsWith('/')) {
            this.path = path.substring(1);
        }
        this.keepAliveInterval = (options.keepaliveInterval ?? DEFAULT_KEEPALIVE_INTERVAL_SEG) * 1000;
        this.keepAliveTimeout = (options.keepaliveTimeout ?? DEFAULT_KEEPALIVE_TIMEOUT_SEG) * 1000;
        this.reconnectDelay = (options.reconnectDelay ?? DEFAULT_RECONNECT_SEG) * 1000;
        this.closeDelay = (options.closeDelay ?? 0) * 1000;
    }
    start(apiUrl: string, getProtocols?: (path: string) => Promise<string[] | null>) {
        this.apiUrl = apiUrl;
        this.apiUrlToJoin = apiUrl.endsWith('/') ? apiUrl.substring(0, apiUrl.length - 1) : apiUrl;
        _getProtocols = getProtocols ?? null;
        if (ws != null) return;
        this.startWs();
    }
    subscribe(onEvent: (ev: string) => void, ping: (pong: () => void) => void, onConnect?: () => void, onDisconnect?: () => void, onClose?: () => void) {
        const s = { onEvent, ping, onConnect, onDisconnect, onClose };
        subscribers.add(s);
        const keepAliveRef = this.keepAlive(s);
        const unsubscribe = Comlink.proxy(() => {
            subscribers.delete(s);
            clearInterval(keepAliveRef);
            if (this.closeDelay !== 0) {
                if (this.closeRef) clearTimeout(this.closeRef);
                this.closeRef = setTimeout(() => this.checkSubscriptions(), this.closeDelay);
            } else {
                this.checkSubscriptions();

            }
        });
        return unsubscribe;
    }
    sendMessage(data: string) {
        ws?.send(data);
    }
    private async startWs() {
        if (ws) return;
        try {
            const protocols = await _getProtocols?.(this.path);
            if (_getProtocols && !protocols) return this.startReconnect();
            const socket = ws = this.openSocket(protocols ?? undefined);
            socket.onmessage = (msg) => {
                subscribers.forEach(s => s.onEvent(msg.data));
            };
            socket.onopen = () => {
                this.stopReconnect();
                subscribers.forEach(s => s.onConnect?.());
            };
            socket.onclose = () => {
                subscribers.forEach(s => s.onDisconnect?.());
                this.startReconnect();
            };
        } catch (error) {
            console.error(error);
            this.startReconnect();
        }

    }
    private startReconnect() {
        if (this.reconnectRef == null)
            this.reconnectRef = setInterval(() => {
                try {
                    ws?.close();
                } catch { }
                ws = null;
                this.startWs();
            }, this.reconnectDelay);
    }
    private stopReconnect() {
        if (this.reconnectRef != null) {
            clearInterval(this.reconnectRef);
            this.reconnectRef = null;
        }
    }
    private keepAlive(s: WorkerWebSocketCtrl) {
        const intervalRef = setInterval(() => {
            const timeoutRef = setTimeout(() => {
                subscribers.delete(s);
                clearInterval(intervalRef);
                s.onClose?.();
                this.checkSubscriptions();
            }, this.keepAliveTimeout);
            s.ping(Comlink.proxy(() => {
                clearTimeout(timeoutRef);
            }));
        }, this.keepAliveInterval);
        return intervalRef;
    }
    private checkSubscriptions() {
        if (!subscribers.size) {
            if (ws) {
                ws.onclose = null;
                this.stopReconnect();
                if (this.closeRef) clearTimeout(this.closeRef)
                this.closeRef = null;
                try {
                    ws.close();
                } catch { }
            }
            this.workerCtx.close();
        }
    }
    private openSocket(protocols?: string[]) {
        return new WebSocket(this.path.length ? `${this.apiUrlToJoin}/${this.path}` : this.apiUrl, protocols);
    }
}