import {
    Client as BaseClient,
    Pool as BasePool,
    type ClientConfig,
    type PoolConfig,
} from "../compat/index";
import { type NeonConfig, neonConfig } from "./config";

function withNeonConfig<T extends ClientConfig>(config: string | T | undefined): ClientConfig {
    const options: ClientConfig =
        typeof config === "string" ? { connectionString: config } : { ...config };
    if (!options.WebSocket && neonConfig.webSocketConstructor) {
        options.WebSocket = neonConfig.webSocketConstructor;
    }
    return options;
}

/** The node-postgres compatible client, taking its WebSocket class from `neonConfig` by default. */
export class Client extends BaseClient {
    /** Per-client settings which fall back to the global `neonConfig`; read when the socket opens */
    readonly neonConfig: Partial<NeonConfig> = Object.create(neonConfig);

    constructor(config?: string | ClientConfig) {
        super(withNeonConfig(config));
    }
}

/** The node-postgres compatible pool, building the `Client` above unless told otherwise. */
export class Pool extends BasePool {
    constructor(options: string | PoolConfig = {}) {
        const config = withNeonConfig(options) as PoolConfig;
        config.Client ??= Client;
        super(config);
    }
}
