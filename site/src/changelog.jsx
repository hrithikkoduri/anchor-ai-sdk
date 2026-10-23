import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight } from "lucide-react";
import { PageShell, repo } from "./ui.jsx";
import releases from "./releases.json";
import "./styles.css";
import "./pages.css";
import "./typography.css";
import "./theme.css";
import "./changelog.css";

function Changelog() {
  useEffect(() => {
    // The fragment exists before this client-rendered page mounts. Restore
    // its target once the timeline is in the DOM, like the docs deep links.
    const frame = requestAnimationFrame(() => {
      document.getElementById(decodeURIComponent(location.hash.slice(1)))
        ?.scrollIntoView({ behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <PageShell page="changelog">
      <div className="container changelog-page">
        <header className="changelog-intro">
          <span className="eyebrow">THE SDK, VERSION BY VERSION</span>
          <h1>Small surface.<br />Steady progress.</h1>
          <p>What changed, what it enables, and where the limits still are.
            Each entry describes its Git tag, not everything on main today.</p>
          <p className="changelog-note">Early alpha. Pin exact versions and test your integration.
            GitHub Releases and npm publication are separate steps.</p>
          <a className="text-link" href={`${repo}/releases`}>GitHub Releases <ArrowUpRight size={14} /></a>
        </header>
        <nav className="version-index" aria-label="Release versions">
          {releases.map(({ version }) => <a key={version} href={`#v${version}`}>v{version}</a>)}
        </nav>
        <ol className="release-timeline">
          {releases.map((release, index) => (
            <li key={release.version}>
              <article id={`v${release.version}`} className="release-entry" aria-labelledby={`release-${release.version}`}>
                <div className="release-stamp">
                  <a href={`#v${release.version}`}>v{release.version}</a>
                  <time dateTime={release.date}>{release.date}</time>
                  {index === 0 ? <span>NEWEST TAG</span> : null}
                </div>
                <div className="release-body">
                  <h2 id={`release-${release.version}`}>{release.title}</h2>
                  <p>{release.summary}</p>
                  <h3>What changed</h3>
                  <ul>{release.added.map((item) => <li key={item}>{item}</li>)}</ul>
                  <div className="release-offers"><h3>What this offers</h3><p>{release.offers}</p></div>
                  <details>
                    <summary>Limits &amp; compatibility</summary>
                    <ul>{release.limits.map((item) => <li key={item}>{item}</li>)}</ul>
                  </details>
                  <div className="release-links">
                    <a href={`${repo}/releases/tag/v${release.version}`}>Release notes ↗</a>
                    <a href={`${repo}/tree/v${release.version}`}>Tagged source ↗</a>
                    {releases[index + 1] ? <a href={`${repo}/compare/v${releases[index + 1].version}...v${release.version}`}>Full diff ↗</a> : null}
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ol>
      </div>
    </PageShell>
  );
}

createRoot(document.getElementById("root")).render(<Changelog />);
