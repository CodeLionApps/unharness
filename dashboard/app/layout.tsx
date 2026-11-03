import './globals.css';
import { profileNames } from '../../src/profiles.ts';
import { currentProfile, dbError, PROFILE_COOKIE } from './lib.tsx';
import { ProfileSwitch } from './profile-switch.tsx';

export const metadata = { title: 'Unharness', description: 'How your coding agents worked, and what it would cost at API prices' };

export default async function Layout({ children }: { children: React.ReactNode }) {
  const profiles = profileNames();
  const err = await dbError();
  return (
    <html lang="en">
      <body>
        <nav className="top" aria-label="Main">
          <a className="brand" href="/">Unharness</a>
          <a href="/">Overview</a>
          <a href="/runs">Runs</a>
          <a href="/compare">Compare</a>
          <a href="/setup">Setup history</a>
          {profiles.length > 1 && <ProfileSwitch profiles={profiles} current={await currentProfile()} cookie={PROFILE_COOKIE} />}
        </nav>
        <main>{err ? <div className="card empty"><h2>Can't open the database</h2><p>{err}</p></div> : children}</main>
      </body>
    </html>
  );
}
