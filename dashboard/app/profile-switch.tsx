'use client';

// Stores the choice in a cookie (read by lib.tsx) and reloads. A run page belongs to one profile, so go to the list.
export function ProfileSwitch({ profiles, current, cookie }: { profiles: string[]; current: string; cookie: string }) {
  return (
    <label className="profile">
      <span>Profile</span>
      <select
        value={current}
        onChange={(e) => {
          document.cookie = `${cookie}=${encodeURIComponent(e.target.value)}; path=/; max-age=31536000; samesite=lax`;
          if (location.pathname.startsWith('/runs/')) location.href = '/runs';
          else location.reload();
        }}
      >
        {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
    </label>
  );
}
