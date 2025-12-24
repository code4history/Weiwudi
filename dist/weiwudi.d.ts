declare class EventTarget {
    constructor();
    addEventListener(type: any, callback: any): void;
    removeEventListener(type: any, callback: any): void;
    dispatchEvent(event: any): boolean;
}
export default class Weiwudi extends EventTarget {
    static registerSW(sw: any, swOptions: any): Promise<ServiceWorkerRegistration>;
    static swCheck(): Promise<any>;
    static registerMap(mapID: any, options: any): Promise<Weiwudi>;
    static retrieveMap(mapID: any): Promise<Weiwudi>;
    static removeMap(mapID: any): Promise<void>;
    constructor(mapID: any, attrs: any);
    release(): void;
    checkAspect(): void;
    stats(): Promise<any>;
    clean(): Promise<void>;
    fetchAll(): Promise<void>;
    remove(): Promise<void>;
    cancel(): Promise<void>;
}
export {};
//# sourceMappingURL=weiwudi.d.ts.map