"use client";
// Dolny pasek w stylu Lyfty: ikony liniowe, siłownia jako wyróżniony środkowy przycisk
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "./Icon";

const ITEMS = [
  ["/", "home", "Pulpit"],
  ["/plan", "plan", "Plan"],
  ["/silownia", "dumbbell", "Trening"],
  ["/postepy", "chart", "Postępy"],
  ["/trener", "chat", "Trener"],
] as const;

export default function Nav() {
  const p = usePathname();
  return (
    <nav className="nav">
      {ITEMS.map(([href, icon, label]) => {
        const on = href === "/" ? p === "/" : p.startsWith(href) || (href === "/postepy" && p.startsWith("/aktywnosci"));
        const mid = href === "/silownia";
        return (
          <Link key={href} href={href} className={`${on ? "on" : ""} ${mid ? "mid" : ""}`}>
            <span className="ic">
              <Icon name={icon} size={mid ? 26 : 22} />
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
