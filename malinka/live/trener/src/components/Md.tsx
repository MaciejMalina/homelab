// Minimalny renderer markdownu z odpowiedzi AI: akapity, listy "-"/"•"/"1.", **pogrubienie**, nagłówki "#".
// Bez dangerouslySetInnerHTML — tekst zawsze trafia do Reacta jako tekst.
import { Fragment, type ReactNode } from "react";

function inline(t: string, key: string): ReactNode[] {
  return t.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong> : <Fragment key={`${key}-${i}`}>{part}</Fragment>,
  );
}

export default function Md({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  const out: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={`p${out.length}`}>{inline(para.join(" "), `p${out.length}`)}</p>);
    if (list.length) out.push(<ul key={`u${out.length}`}>{list.map((l, i) => <li key={i}>{inline(l, `l${out.length}-${i}`)}</li>)}</ul>);
    para = [];
    list = [];
  };
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    const h = l.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); out.push(<h4 key={`h${out.length}`}>{inline(h[1], `h${out.length}`)}</h4>); continue; }
    const li = l.match(/^(?:[-•*]|\d+[.)])\s+(.*)$/);
    if (li) { if (para.length) { const p = para; para = []; out.push(<p key={`p${out.length}`}>{inline(p.join(" "), `pp${out.length}`)}</p>); } list.push(li[1]); continue; }
    if (list.length) flush();
    para.push(l);
  }
  flush();
  return <div className="md">{out}</div>;
}
