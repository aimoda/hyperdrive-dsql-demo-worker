import Cloudflare from 'cloudflare';
import { AwsV4Signer } from "aws4fetch";

/**
 * The Env interface describes all the environment variables needed by this Worker.
 * Adjust these values in your Worker configuration or .env file to match your setup.
 */
export interface Env {
  // Used for any environment-based checks if necessary (e.g., "dev", "staging", "prod").
  ENVIRONMENT: string;

  // AWS DSQL region names (primary and secondary, if you have multiple Aurora DSQL endpoints).
  AWS_DSQL_REGION_PRIMARY: string;
  AWS_DSQL_REGION_SECONDARY: string;

  // AWS credentials for IAM authentication.
  AWS_DSQL_ACCESS_KEY_ID: string;
  AWS_DSQL_SECRET_ACCESS_KEY: string;

  // Aurora DSQL endpoint hostnames (primary and secondary). These are typically something like "xxxxxx.cluster-xxxxxx.us-east-1.dsql.amazonaws.com".
  AWS_DSQL_ENDPOINT_PRIMARY: string;
  AWS_DSQL_ENDPOINT_SECONDARY: string;

  // Cloudflare API tokens and account identifiers.
  CLOUDFLARE_API_KEY_HYPERDRIVE: string;  // API token with permissions to manage/edit Hyperdrive configs
  CLOUDFLARE_ACCOUNT_ID: string;         // Your Cloudflare Account ID
}

/**
 * Represents the configuration for a single Aurora DSQL endpoint.
 */
interface EndpointConfig {
  configName: string; // The name of the Hyperdrive config within Cloudflare
  host: string;       // The Aurora DSQL endpoint hostname
  region: string;     // The AWS region for this endpoint
}

/**
 * HyperdriveOrigin defines how the origin database is described to Cloudflare Hyperdrive.
 * scheme, database, user, host, port, and password collectively tell Hyperdrive how to connect.
 */
interface HyperdriveOrigin {
  scheme: "postgres" | "postgresql"; // Scheme must match the underlying DB engine (Aurora DSQL is Postgres-compatible).
  database: string;                  // Database name.
  user: string;                      // Database user (for IAM, a placeholder user is common, e.g., 'admin').
  host: string;                      // The Aurora DSQL cluster endpoint.
  port: number;                      // Typically 5432 for PostgreSQL.
  password: string;                  // This is actually the IAM token (instead of a traditional password).
}

/**
 * Generate a presigned "dsql" connection URL (minus the "https://" prefix).
 * 
 * This uses the AwsV4Signer to sign a "DbConnectAdmin" request, which gives you an IAM-based
 * token suitable for Aurora DSQL. Aurora DSQL requires IAM authentication, so we generate
 * a presigned token that Cloudflare Hyperdrive will use as the "password".
 *
 * @param yourClusterEndpoint The Aurora DSQL endpoint (e.g., xxxxxx.cluster-xxxxxx.us-east-1.dsql.amazonaws.com).
 * @param region              The AWS region (e.g., "us-east-1").
 * @param action              The DSQL action to sign for, typically "DbConnectAdmin" for admin privileges.
 * @param accessKeyId         Your AWS IAM Access Key ID.
 * @param secretAccessKey     Your AWS IAM Secret Access Key.
 * @param sessionToken        Optional session token if using temporary credentials (e.g., from STS).
 * @returns                   A promise that resolves with the signed URL path (without the "https://" prefix).
 */
export async function generateDbConnectAdminAuthToken(
  yourClusterEndpoint: string,
  region: string,
  action: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string
): Promise<string> {
  console.log("[generateDbConnectAdminAuthToken] Starting IAM token generation...");

  // Construct a URL that includes the DSQL action and expiration in the query string.
  const url = new URL(`https://${yourClusterEndpoint}`);
  url.searchParams.set('Action', action);
  // X-Amz-Expires is how long the token is valid. 604800 seconds = 1 week, which is the max for Aurora DSQL.
  url.searchParams.set('X-Amz-Expires', '604800');

  console.log(`[generateDbConnectAdminAuthToken] Preparing to sign URL: ${url.toString()}`);

  // Create an AwsV4Signer instance, specifying "dsql" as the AWS service and enabling query signing.
  const signer = new AwsV4Signer({
    url: url.toString(),
    method: 'GET',
    service: 'dsql',
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    signQuery: true, // The signature is placed in the query string.
  });

  // Sign the request, which returns a fully signed URL with signature parameters attached.
  const { url: signedUrl } = await signer.sign();
  console.log("[generateDbConnectAdminAuthToken] Signed URL obtained");

  // Return the signed URL, but remove the "https://" prefix because Hyperdrive expects just the host + query params.
  const trimmedUrl = signedUrl.toString().substring('https://'.length);
  console.log(`[generateDbConnectAdminAuthToken] Trimmed token (used as password): ${trimmedUrl.substring(0, 5)}...`);

  return trimmedUrl;
}

/**
 * Helper function to either update an existing Hyperdrive config or create a new one.
 *
 * @param client         The Cloudflare client instance.
 * @param accountId      The Cloudflare Account ID.
 * @param endpoint       The endpoint configuration object (host, region, configName).
 * @param existingConfig If a config with the same name already exists, it will be updated.
 * @param password       The "password" is actually the IAM token for Aurora DSQL.
 * @returns              A promise resolving to the created/updated configuration object.
 */
async function upsertConfig(
  client: Cloudflare,
  accountId: string,
  endpoint: EndpointConfig,
  existingConfig: any | undefined,
  password: string
) {
  // This describes the database origin to Hyperdrive.
  // Notice that `password` is actually our presigned IAM token.
  const origin: HyperdriveOrigin = {
    scheme: 'postgres',
    database: 'postgres',
    user: 'admin',
    host: endpoint.host,
    port: 5432,
    password,
  };

  // If a config with the same name was found, update it.
  if (existingConfig) {
    console.log(`Found existing endpoint config "${endpoint.configName}" ... updating`);

    // We use the 'edit' method on the existing config's ID, passing the new origin details.
    const response = await client.hyperdrive.configs.edit(existingConfig.id, {
      account_id: accountId,
      origin,
    });

    console.log(`Updated configuration for: ${endpoint.configName}`);
    return response;
  }

  // Otherwise, create a brand-new configuration in Hyperdrive.
  console.log(`Creating configuration for endpoint "${endpoint.configName}"`);
  const response = await client.hyperdrive.configs.create({
    account_id: accountId,
    name: endpoint.configName,
    origin,
  });
  console.log(`Created new configuration: ${endpoint.configName}`);
  return response;
}

/**
 * The default export is the Worker script entry point. It has two handlers:
 * 1. fetch: handles HTTP requests (in this example, returns 404 by default).
 * 2. scheduled: handles Cron Trigger invocations to keep Hyperdrive configurations in sync.
 */
export default {
  /**
   * The fetch event handler is triggered on HTTP requests to this Worker.
   * For now, it returns a 404 Not Found response since our main logic is in the scheduled event.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    console.log("[fetch] Received HTTP request. Returning 404 as this Worker is only for scheduled tasks.");
    return new Response(null, { status: 404 });
  },

  /**
   * The scheduled event handler is triggered by a Cron Trigger in Cloudflare Workers.
   * It updates (or creates) Hyperdrive configurations for the Aurora DSQL endpoints using IAM tokens.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    console.log("Starting Hyperdrive configuration update...");

    // Instantiate the Cloudflare client using the token from the environment.
    const client = new Cloudflare({
      apiToken: env.CLOUDFLARE_API_KEY_HYPERDRIVE,
    });

    /**
     * Define the endpoints we want to configure in Hyperdrive.
     * We have a primary and a secondary cluster endpoint, each in potentially different AWS regions.
     */
    const endpoints: EndpointConfig[] = [
      {
        configName: "dsql-admin-demo-primary",
        host: env.AWS_DSQL_ENDPOINT_PRIMARY,
        region: env.AWS_DSQL_REGION_PRIMARY,
      },
      {
        configName: "dsql-admin-demo-secondary",
        host: env.AWS_DSQL_ENDPOINT_SECONDARY,
        region: env.AWS_DSQL_REGION_SECONDARY,
      },
    ];

    // Generate IAM tokens for each endpoint in parallel using our generateDbConnectAdminAuthToken function.
    console.log("Generating authentication tokens for each Aurora DSQL endpoint...");
    const tokenPromises = endpoints.map((ep) =>
      generateDbConnectAdminAuthToken(
        ep.host,
        ep.region,
        "DbConnectAdmin",
        env.AWS_DSQL_ACCESS_KEY_ID,
        env.AWS_DSQL_SECRET_ACCESS_KEY
      )
    );

    // Retrieve the existing Hyperdrive configs for our Cloudflare account.
    console.log("Fetching existing Hyperdrive configurations from Cloudflare...");
    const existingConfigs: Record<string, any> = {};
    for await (const config of client.hyperdrive.configs.list({
      account_id: env.CLOUDFLARE_ACCOUNT_ID,
    })) {
      // We store them in a dictionary keyed by the config name.
      existingConfigs[config.name] = config;
      console.log(`[Existing Config] Found config with name: ${config.name}`);
    }

    // Wait for all token generation promises to resolve.
    console.log("Waiting for all IAM tokens to be generated...");
    const tokens = await Promise.all(tokenPromises);

    // Upsert (create or update) our Hyperdrive configurations in parallel.
    console.log("Upserting Hyperdrive configurations for each endpoint...");
    await Promise.all(
      endpoints.map((ep, index) =>
        upsertConfig(
          client,
          env.CLOUDFLARE_ACCOUNT_ID,
          ep,
          existingConfigs[ep.configName],
          tokens[index]
        )
      )
    );

    // Done!
    console.log("Hyperdrive configuration update complete!");
  },
};
