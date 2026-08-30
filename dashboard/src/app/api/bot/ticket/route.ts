import { NextResponse } from 'next/server';
import { getAuthSession } from '@/lib/auth-server';
import { readBotApiConfig, signBotTicket, TICKET_LIFETIME_MS } from '@/lib/bot-api';

export async function POST() {
  const config = readBotApiConfig();
  if (!config) {
    return NextResponse.json({ error: 'dashboard api not configured' }, { status: 503 });
  }

  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const expiresAt = Date.now() + TICKET_LIFETIME_MS;
  return NextResponse.json(
    {
      ticket: signBotTicket(session.userId, expiresAt, config.secret),
      userId: session.userId,
      expiresAt,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
