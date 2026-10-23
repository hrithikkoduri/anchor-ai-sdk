import React, { useEffect, useRef, useState } from "react";
import * as Tooltip from "@animate-ui/react/primitives/radix-ui/tooltip";
import * as Collapsible from "@animate-ui/react/primitives/radix-ui/collapsible";
import { MotionConfig } from "motion/react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Github,
  Plus,
  Terminal,
} from "lucide-react";
import logo from "../assets/logo.svg";

export const repo = "https://github.com/hrithikkoduri/anchor-ai-sdk";

export function Brand() {
  return (
    <a className="brand" href="/" aria-label="Anchor home">
      <img src={logo} alt="" />
      anchor<span className="brand-dot">.</span>
    </a>
  );
}

export function SiteHeader({ page }) {
  const [mobile, setMobile] = useState(false);
  const links = [
    ["The harness", "/#harness", "home"],
    ["Docs", "/docs.html", "docs"],
    ["Benchmarks", "/benchmarks.html", "benchmarks"],
    ["Changelog", "/changelog.html", "changelog"],
  ];
  const items = links.map(([label, href, id]) => (
    <a
      key={id}
      href={href}
      aria-current={page === id && id !== "home" ? "page" : undefined}
      onClick={() => setMobile(false)}
    >
      {label}
    </a>
  ));
  return (
    <Collapsible.Root open={mobile} onOpenChange={setMobile} asChild>
      <header className="navigation">
        <div className="container nav-row">
          <Brand />
          <nav className="desktop-nav" aria-label="Main navigation">
            {items}
          </nav>
          <a
            className="github-link"
            href={repo}
            aria-label="Star Anchor on GitHub"
          >
            <Github size={16} />
            <span>Star on GitHub</span>
            <ArrowUpRight size={14} />
          </a>
          <Collapsible.Trigger asChild>
            <button className="mobile-toggle" type="button">
              {mobile ? "Close" : "Menu"} <Plus size={16} />
            </button>
          </Collapsible.Trigger>
        </div>
        <Collapsible.Content asChild>
          <nav className="mobile-nav" aria-label="Mobile navigation">
            {items}
            <a href={repo}>GitHub ↗</a>
          </nav>
        </Collapsible.Content>
      </header>
    </Collapsible.Root>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="container footer-top">
        <Brand />
        <p>Keep the agent grounded.</p>
        <div>
          <a href="/docs.html">Docs</a>
          <a href="/changelog.html">Changelog</a>
          <a href={repo}>GitHub ↗</a>
          <a href="https://www.npmjs.com/package/anchor-ai-sdk">npm ↗</a>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>OPEN SOURCE BY DESIGN.</span>
        <span>MIT LICENSE · BUILT FOR THE LONG RUN</span>
        <a href={`${repo}/blob/main/DECISIONS.md`}>
          The decisions behind the design <ArrowUpRight size={11} />
        </a>
      </div>
    </footer>
  );
}

export function PageShell({ page, children }) {
  return (
    <MotionConfig reducedMotion="user">
      <Tooltip.Provider delayDuration={200}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader page={page} />
        <main id="main">{children}</main>
        <SiteFooter />
      </Tooltip.Provider>
    </MotionConfig>
  );
}

export function CopyButton({ text, label = "Copy command", className = "" }) {
  const [state, setState] = useState("idle");
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className={`copy-button ${className}`}
          onClick={copy}
          aria-label={state === "copied" ? "Copied" : label}
        >
          {state === "copied" ? <Check size={15} /> : <Copy size={15} />}
          <span className="sr-only" role="status">
            {state === "copied"
              ? "Copied to clipboard"
              : state === "failed"
                ? "Clipboard unavailable. Select the text to copy."
                : ""}
          </span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={8}>
          {state === "copied"
            ? "Copied!"
            : state === "failed"
              ? "Select text to copy"
              : label}
          <Tooltip.Arrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// Small lexical highlighter: React escapes every token; no HTML injection.
function highlight(code) {
  return code
    .split(
      /(\/\/[^\n]*|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:import|from|const|await|try|finally|new|async|return|export|true|false)\b|\b\d[\d_]*\b)/g,
    )
    .map((token, i) => {
      const style = /^(\/\/|#)/.test(token)
        ? "syntax-muted"
        : /^["']/.test(token)
          ? "syntax-green"
          : /^(import|from|const|await|try|finally|new|async|return|export|true|false|\d[\d_]*)$/.test(
                token,
              )
            ? "syntax-orange"
            : undefined;
      return style ? (
        <span className={style} key={i}>
          {token}
        </span>
      ) : (
        token
      );
    });
}

export function CodeBlock({
  code,
  filename = "agent.ts",
  language = "TYPESCRIPT",
}) {
  return (
    <div className="code-window doc-code">
      <div className="code-header">
        <span>
          <Terminal size={12} />
          {filename}
        </span>
        <span className="code-language">{language}</span>
        <CopyButton text={code} label={`Copy ${filename}`} />
      </div>
      <pre tabIndex={0} aria-label={`${filename} code example`}>
        <code>{highlight(code)}</code>
      </pre>
    </div>
  );
}
