/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { Weiwudi_Internal } from "./weiwudi_gw_logic.ts";
import { registerRoute } from "workbox-routing";

// Initialize Weiwudi with Workbox route registration
Weiwudi_Internal(registerRoute);