import * as Comlink from 'comlink';
import type { WorkerWsController } from './worker-websocket-controller';

export class WorkerWsSubscriptions<T extends string = string> {
    private api: string | (() => string);
    private createWorker: (resource: T) => Worker | SharedWorker | undefined;
    private getProtocolsProxy?: (() => Promise<string[] | null>) & Comlink.ProxyMarked;
    private autoUnsubscribeBinded?: ((this: WorkerWsSubscriptions<T>, ctx: unknown, unsubscribe: () => void) => void);
    constructor(options: { api: string | (() => string), createWorker: (resource: T) => Worker | SharedWorker | undefined, getProtocols?: () => Promise<string[] | null>, autoUnsubscribe?: (this: WorkerWsSubscriptions<T>, ctx: unknown, unsubscribe: () => void) => void }) {
        this.api = options.api;
        this.createWorker = options.createWorker;
        if (options.getProtocols) {
            this.getProtocolsProxy = Comlink.proxy(options.getProtocols);
        }
        if (options.autoUnsubscribe) {
            this.autoUnsubscribeBinded = options.autoUnsubscribe.bind(this);
        }
    }
    workers: Map<T, Comlink.Remote<WorkerWsController> | undefined> = new Map();
    subscriptions: Map<T, Map<unknown, { unsubscribe: () => void }>> = new Map();
    async subscribe(ctx: unknown, resource: T, onEvent: (msg: string) => void, onConnect?: () => void) {
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
            this.workers.set(resource, workerWs);
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
                onConnect?.();
            }),
            Comlink.proxy(() => {
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
        }
    }
}