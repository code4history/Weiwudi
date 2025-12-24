/// <reference lib="webworker" />
import { Weiwudi_Internal } from "./weiwudi_gw_logic";

declare const self: ServiceWorkerGlobalScope & {
    workbox: {
        routing: {
            registerRoute: any; // Type strictly if possible, or import from workbox-routing type
        }
    }
};

Weiwudi_Internal(self.workbox.routing.registerRoute);