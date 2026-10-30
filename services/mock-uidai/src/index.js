import { createLogger } from "@authentix/logger";
import { buildApp } from "./app.js";

const logger = createLogger("mock-uidai");
const env = process.env;
if (env.NODE_ENV === "production") throw new Error("mock-uidai is dev only and must not run in production");

const app = await buildApp({ logger, config: { otp: env.MOCK_UIDAI_OTP ?? "123456" } });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => app.close().then(() => process.exit(0)));
}

await app.listen({ port: Number(env.PORT ?? 3010), host: "0.0.0.0" });
