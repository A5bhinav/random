import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  const server = await buildServer(config);

  await server.listen({ port: config.PORT, host: config.HOST });
  server.log.info(`Server listening on ${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
