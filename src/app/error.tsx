"use client";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="unlock-screen" id="main-content"><div className="unlock-card"><span className="eyebrow">NEXT HARNESS</span><h1>A small detour.</h1><p>The workspace could not render. Your saved sessions are still on the server.</p><button className="button primary" onClick={reset}>Try again</button></div></main>;
}
