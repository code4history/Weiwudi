export declare class WeiwudiEventTarget {
    listeners: Record<string, ((...args: unknown[]) => void)[]>;
    constructor();
    addEventListener(type: string, callback: (...args: unknown[]) => void): void;
    removeEventListener(type: string, callback: (...args: unknown[]) => void): void;
    dispatchEvent(event: Event | CustomEvent): boolean;
}
export interface WeiwudiOptions {
    type?: string;
    url?: string;
    width?: number;
    height?: number;
    tileSize?: number;
    minZoom?: number;
    maxZoom?: number;
    maxLng?: number;
    maxLat?: number;
    minLng?: number;
    minLat?: number;
    [key: string]: unknown;
}
export interface WeiwudiInternalOps {
    [key: string]: unknown;
}
export default class Weiwudi extends WeiwudiEventTarget {
    mapID?: string;
    url?: string;
    listener: (e: MessageEvent) => void;
    static registerSW(sw: string | URL, swOptions?: RegistrationOptions): Promise<ServiceWorkerRegistration>;
    static swCheck(): Promise<boolean>;
    static registerMap(mapID: string, options: WeiwudiOptions): Promise<Weiwudi>;
    static retrieveMap(mapID: string): Promise<Weiwudi>;
    static removeMap(mapID: string): Promise<void>;
    constructor(mapID: string, attrs?: WeiwudiOptions);
    release(): void;
    checkAspect(): void;
    stats(): Promise<any>;
    clean(): Promise<void>;
    fetchAll(): Promise<void>;
    remove(): Promise<void>;
    cancel(): Promise<void>;
}
//# sourceMappingURL=weiwudi.d.ts.map