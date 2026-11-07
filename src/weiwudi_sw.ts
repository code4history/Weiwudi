/// <reference lib="webworker" />
import { Weiwudi_Internal } from "./weiwudi_gw_logic";

// 差し込み口（#36・仕様 §8）と提供元（#40・仕様 §10）。UMD では self.Weiwudi_SW.addPlugin・addProvider として使う
export { addPlugin, addProvider } from "./plugins";

declare const self: ServiceWorkerGlobalScope & {
    workbox: {
        routing: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            registerRoute: any;
        }
    }
};

Weiwudi_Internal(self.workbox.routing.registerRoute);
