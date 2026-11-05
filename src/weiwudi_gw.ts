import {registerRoute} from "workbox-routing";
import {Weiwudi_Internal} from "./weiwudi_gw_logic";

// 差し込み口（#36・仕様 §8）と提供元（#40・仕様 §10）。副作用 import（`import '@c4h/weiwudi/sw'`）はこれまでどおり動く
export { addPlugin, addProvider } from "./plugins";
export type { WeiwudiPlugin, WeiwudiProvider } from "./plugins";
export type { Credentials, ResourceInfo, ResourceType } from "./store";

Weiwudi_Internal(registerRoute);
