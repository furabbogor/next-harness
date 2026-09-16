import Link from "next/link";
export default function NotFound() {
  return <main className="unlock-screen" id="main-content"><div className="unlock-card"><span className="eyebrow">404 · NEXT HARNESS</span><h1>Not quite here.</h1><p>That page doesn’t exist. Your workspace is one click away.</p><Link className="button primary" href="/">Back to workspace</Link></div></main>;
}
