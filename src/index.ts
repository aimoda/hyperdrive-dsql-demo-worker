export interface Env {
	ENVIRONMENT: string;
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.debug("invoking cron");

		// ctx.waitUntil();
	}
};
