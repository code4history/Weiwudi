import {registerRoute} from "workbox-routing";
import {Weiwudi_Internal} from "./weiwudi_gw_logic";

// 差し込み口（#36）と提供元（#40）と上流へ送る User-Agent（setUserAgent）。副作用 import（`import '@c4h/weiwudi/sw'`）はこれまでどおり動く
export { addPlugin, addProvider, setUserAgent } from "./plugins";
export type { WeiwudiPlugin, WeiwudiProvider } from "./plugins";
export type { Credentials, ResourceInfo, ResourceType } from "./store";

Weiwudi_Internal(registerRoute);
