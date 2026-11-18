/// <reference lib="webworker" />
import { Weiwudi_Internal } from "./weiwudi_gw_logic";

// 差し込み口（#36）と提供元（#40）と上流へ送る User-Agent（setUserAgent）。UMD では self.Weiwudi_SW.addPlugin・addProvider・setUserAgent として使う
export { addPlugin, addProvider, setUserAgent } from "./plugins";

declare const self: ServiceWorkerGlobalScope & {
    workbox: {
        routing: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            registerRoute: any;
        }
    }
};

Weiwudi_Internal(self.workbox.routing.registerRoute);
