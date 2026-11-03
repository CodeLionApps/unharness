export const dynamic = 'force-dynamic';

// Identity probe for `unharness dashboard`: is this port our dashboard, which build/profile it serves, which pid to stop.
export function GET() {
  return Response.json({ app: 'unharness', pid: process.pid, build: process.env.UNHARNESS_BUILD, profile: process.env.UNHARNESS_PROFILE });
}
