import { bridgePort, loadBridgeEnv, publicOrigin } from "../dist/runtime.js";

loadBridgeEnv();
const { hostname, port } = new URL(publicOrigin());
const labels = hostname.split(".");
if (port || labels.length < 2 || hostname.length > 253 ||
    labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /^\d+$/.test(labels.at(-1))) {
  throw new Error("The named tunnel requires a public DNS hostname on the standard HTTPS port.");
}
const bridge = bridgePort();
if (!bridge || bridge === 19225) throw new Error("Set a fixed PORT distinct from the tunnel metrics port (19225).");
console.log(JSON.stringify({ hostname, bridge }));
