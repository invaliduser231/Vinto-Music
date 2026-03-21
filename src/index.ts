import 'dotenv/config';
import { startApp } from './app/bootstrap.ts';

try {
  await startApp();
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
}


