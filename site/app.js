/* Anchor — site interactions. Tiny on purpose: copy buttons + current-page nav. */
(() => {
  // Copy buttons: any .copy[data-copy="#selector"] copies that node's text.
  document.addEventListener("click", async (event) => {
    const btn = event.target.closest(".copy");
    if (!btn) return;
    const sel = btn.getAttribute("data-copy");
    const node = sel ? document.querySelector(sel) : btn.closest(".term, .install")?.querySelector("pre, code");
    const text = node?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = "copied";
      btn.classList.add("done");
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove("done");
      }, 1400);
    } catch {
      /* clipboard blocked (http); select the block instead */
      const range = document.createRange();
      if (node) {
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  });

  // Mark the nav link for the current page.
  const here = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-links a[data-page]").forEach((a) => {
    if (a.getAttribute("data-page") === here) a.setAttribute("aria-current", "page");
  });
})();
