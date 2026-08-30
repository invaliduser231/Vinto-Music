import { readOAuthConfig } from '@/lib/oauth-config';

export function GET() {
  return Response.json({ enabled: readOAuthConfig() !== null });
}
