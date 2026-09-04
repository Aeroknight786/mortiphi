import { Marked, Renderer } from "marked";

const renderer = new Renderer();
renderer.html = () => "";
renderer.code = ({ text, lang }) => `<div class="code-block"><button class="copy-code" type="button" data-copy="${encodeURIComponent(text)}">Copy</button><pre><code class="language-${lang?.replace(/[^\w-]/g, "") ?? "text"}">${escapeHtml(text)}</code></pre></div>`;
const parser = new Marked({ renderer, breaks: true, gfm: true });

export function markdown(text: string) {
  let html: string;
  try {
    html = parser.parse(text) as string;
  } catch (error) {
    console.error("Could not render transcript Markdown.", error);
    html = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of [...doc.body.querySelectorAll("script,style,iframe,object,embed,form,input,button:not(.copy-code)")]) element.remove();
  for (const link of [...doc.body.querySelectorAll("a")]) {
    const href = link.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) {
      link.replaceWith(...link.childNodes);
      continue;
    }
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  }
  for (const element of [...doc.body.querySelectorAll("*" as any)] as Element[]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === "style" || attribute.name === "srcdoc") element.removeAttribute(attribute.name);
    }
  }
  return { __html: doc.body.innerHTML };
}

export function handleMarkdownClick(event: MouseEvent) {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(".copy-code");
  if (!target?.dataset.copy) return;
  void navigator.clipboard.writeText(decodeURIComponent(target.dataset.copy));
  target.textContent = "Copied";
  window.setTimeout(() => { target.textContent = "Copy"; }, 1200);
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!); }
