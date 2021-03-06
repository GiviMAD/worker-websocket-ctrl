import * as Comlink from 'comlink';
import type { WorkerWsController } from './worker-websocket-controller';
export class WorkerWsSubscriptions<T extends string = string> {
    private api: string | (() => string);
    private createWorker: (resource: T) => Worker | SharedWorker | undefined;
    private getProtocolsProxy?: ((path: string) => Promise<string[] | null>) & Comlink.ProxyMarked;
    private autoUnsubscribeBinded?: ((this: WorkerWsSubscriptions<T>, ctx: unknown, unsubscribe: () => void) => void);
    private pathByResource = new Map<T, string>();
    private resourceByPath = new Map<string, T>();
    constructor(options: { api: string | (() => string), createWorker: (resource: T) => Worker | SharedWorker | undefined, getProtocols?: (resource: T) => Promise<string[] | null>, autoUnsubscribe?: (this: WorkerWsSubscriptions<T>, ctx: unknown, unsubscribe: () => void) => void }) {
        this.api = options.api;
        this.createWorker = options.createWorker;
        if (options.getProtocols) {
            const getProtocols = options.getProtocols;
            this.getProtocolsProxy = Comlink.proxy(async (path: string) => {
                const resource = this.resourceByPath.get(path);
                if (!resource) {
                    console.error(`Unable to get resource name for path ${path}`);
                    return null;
                }
                return getProtocols(resource);
            });
        }
        if (options.autoUnsubscribe) {
            this.autoUnsubscribeBinded = options.autoUnsubscribe.bind(this);
        }
    }
    workers: Map<T, Comlink.Remote<WorkerWsController> | undefined> = new Map();
    subscriptions: Map<T, Map<unknown, { unsubscribe: () => void }>> = new Map();
    async subscribe(ctx: unknown, resource: T, onEvent: (msg: string) => void, hooks: { onConnect?: () => void, onDisconnect?: () => void, onClosed?: () => void } = {}) {
        let subscriptions = this.subscriptions.get(resource)
        if (subscriptions == null) {
            subscriptions = new Map();
            this.subscriptions.set(resource, subscriptions);
        } else if (subscriptions.has(this)) {
            return;
        }
        this.autoUnsubscribeBinded?.(ctx, () => this.unsubscribe(ctx, resource));
        let workerWs: Comlink.Remote<WorkerWsController>;
        const currentWorker = this.workers.get(resource);
        let _worker: Worker | SharedWorker | undefined;
        if (!currentWorker) {
            _worker = this.createWorker(resource)
            if (!_worker) {
                this.checkSubscriptions(resource);
                throw new Error(`Unable to create worker for resource ${resource}`);
            }
            workerWs = Comlink.wrap<WorkerWsController>(_worker instanceof Worker ? _worker : _worker.port);
            const path = await workerWs.path;
            this.workers.set(resource, workerWs);
            this.pathByResource.set(resource, path);
            this.resourceByPath.set(path, resource);
        } else {
            workerWs = currentWorker;
        }
        await workerWs.start(
            typeof this.api === 'string' ? this.api : this.api(),
            this.getProtocolsProxy
        );
        const unsubscribe = await workerWs.subscribe(
            Comlink.proxy((data: string) => {
                onEvent(data);
            }),
            Comlink.proxy(pong => {
                pong()
            }),
            Comlink.proxy(() => {
                hooks.onConnect?.();
            }),
            Comlink.proxy(() => {
                hooks.onDisconnect?.();
            }),
            Comlink.proxy(() => {
                hooks.onConnect?.()
                console.error('Connection closed from the worker');
                this.subscriptions.get(resource)?.delete(ctx);
                this.checkSubscriptions(resource);
            }),
        );
        subscriptions.set(ctx, { unsubscribe });
        return (msg: string) => workerWs.sendMessage(msg);
    }
    unsubscribe(ctx: unknown, ...resources: T[]) {
        for (const resource of resources) {
            const resourceSubs = this.subscriptions.get(resource);
            const subscription = resourceSubs?.get(ctx);
            if (subscription) {
                subscription.unsubscribe();
                resourceSubs?.delete(ctx);
                this.checkSubscriptions(resource);
            }
        }
    }
    private checkSubscriptions(resource: T) {
        if ((this.subscriptions.get(resource)?.size) === 0) {
            this.workers.delete(resource);
            const path = this.pathByResource.get(resource);
            this.pathByResource.delete(resource);
            if (path) this.resourceByPath.delete(path);
        }
    }
}