/// <reference lib="webworker" />
import { Weiwudi_Internal } from "./weiwudi_gw_logic";

// 差し込み口（#36・仕様 §8）。UMD では self.Weiwudi_SW.addPlugin として使う
export { addPlugin } from "./plugins";

declare const self: ServiceWorkerGlobalScope & {
    workbox: {
        routing: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            registerRoute: any;
        }
    }
};

Weiwudi_Internal(self.workbox.routing.registerRoute);
