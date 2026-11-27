// Ikony liniowe 24×24 (rysowane ręcznie, bez zewnętrznej biblioteki)
const P: Record<string, React.ReactNode> = {
  home: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h5v-6h4v6h5V10" /></>,
  watch: <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 6l1-3h4l1 3M9 18l1 3h4l1-3M12 9v3l2 1.5" /></>,
  dumbbell: <><path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11" /></>,
  plan: <><rect x="4" y="5" width="16" height="16" rx="2.5" /><path d="M4 10h16M9 3v4M15 3v4M8 14h3M8 17h6" /></>,
  chart: <><path d="M4 20h16" /><path d="M6 16l4-5 3 3 5-7" /><circle cx="18" cy="7" r="1.2" /></>,
  chat: <><path d="M5 18l-1.5 3 4-1.5A8.5 8.5 0 1 0 4 12c0 2.3.8 4.4 2 6z" /><path d="M8.5 11h7M8.5 14h4" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>,
  play: <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  more: <><circle cx="6" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="18" cy="12" r="1.3" fill="currentColor" /></>,
  trash: <><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5" /></>,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  back: <path d="M15 5l-7 7 7 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  timer: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9.5 2.5h5" /></>,
  plates: <><rect x="3" y="7" width="3" height="10" rx="1" /><rect x="7" y="4.5" width="3.5" height="15" rx="1" /><path d="M10.5 12h11" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  template: <><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  fire: <path d="M12 21c4 0 6.5-2.7 6.5-6.3 0-3.6-2.6-5.6-3.6-8.7-1.7 1.4-2.3 3-2.4 4.4C11.3 8.6 10 6.3 10.3 3 7 5.3 5.5 9.3 5.5 14.7 5.5 18.3 8 21 12 21z" />,
  edit: <><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 20h7M10 17h4" /></>,
};

export default function Icon({ name, size = 22, className, style }: { name: keyof typeof P | string; size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  );
}
