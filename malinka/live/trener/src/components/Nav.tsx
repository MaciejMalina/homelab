"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  ["/", "🏠", "Pulpit"],
  ["/aktywnosci", "⌚", "Treningi"],
  ["/silownia", "🏋️", "Siłownia"],
  ["/plan", "📋", "Plan"],
  ["/trener", "💬", "Trener"],
] as const;

export default function Nav() {
  const p = usePathname();
  return (
    <nav className="nav">
      {ITEMS.map(([href, icon, label]) => {
        const on = href === "/" ? p === "/" : p.startsWith(href);
        return (
          <Link key={href} href={href} className={on ? "on" : ""}>
            <span>{icon}</span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
