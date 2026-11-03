import {registerRoute} from "workbox-routing";
import {Weiwudi_Internal} from "./weiwudi_gw_logic";

// 差し込み口（#36・仕様 §8）。副作用 import（`import '@c4h/weiwudi/sw'`）はこれまでどおり動く
export { addPlugin } from "./plugins";
export type { WeiwudiPlugin } from "./plugins";
export type { ResourceInfo, ResourceType } from "./store";

Weiwudi_Internal(registerRoute);
