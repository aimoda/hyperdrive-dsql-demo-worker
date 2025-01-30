import Cloudflare from 'cloudflare';

export interface Env {
	ENVIRONMENT: string;
	AWS_DSQL_REGION_PRIMARY: string;
	AWS_DSQL_REGION_SECONDARY: string;
	AWS_DSQL_ACCESS_KEY_ID: string;
	AWS_DSQL_SECRET_ACCESS_KEY: string;
	AWS_DSQL_ENDPOINT_PRIMARY: string;
	AWS_DSQL_ENDPOINT_SECONDARY: string;
	CLOUDFLARE_API_KEY_HYPERDRIVE: string;
	CLOUDFLARE_API_KEY: string;
	CLOUDFLARE_ACCOUNT_ID: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return new Response(null, {status: 404});
	},
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.debug("invoking cron");

		const client = new Cloudflare({
			apiToken: env.CLOUDFLARE_API_KEY_HYPERDRIVE,
		});

		for await (const configListResponse of client.hyperdrive.configs.list({
			account_id: env.CLOUDFLARE_ACCOUNT_ID,
		})) {
			console.log(configListResponse);
		}

		// ctx.waitUntil();
	}
};
