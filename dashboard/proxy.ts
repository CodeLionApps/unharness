import { NextResponse, type NextRequest } from 'next/server';

// The server stays up in the background on localhost: refuse foreign Host headers so a web page
// can't read it through DNS rebinding.
const LOCAL = new Set(['127.0.0.1', 'localhost']);

export function proxy(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
  if (!LOCAL.has(host)) return new NextResponse('forbidden host', { status: 403 });
}
