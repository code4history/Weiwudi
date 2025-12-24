/// <reference lib="webworker" />
import { Weiwudi_Internal } from "./weiwudi_gw_logic";

declare const self: ServiceWorkerGlobalScope & {
    workbox: {
        routing: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            registerRoute: any;
        }
    }
};

Weiwudi_Internal(self.workbox.routing.registerRoute);