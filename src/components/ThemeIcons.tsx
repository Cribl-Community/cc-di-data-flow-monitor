// @capra/icons has no Sun/Moon/Monitor glyphs (confirmed by inspecting its full icon list), so
// these three are hand-drawn to match its own convention: 20x20 viewBox, 1em sizing, currentColor.
// Kept minimal and stroke-based since inventing solid-fill glyphs by eye risks looking inconsistent.

function IconBase({ children }: { children: React.ReactNode }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

export function SunIcon() {
  return (
    <IconBase>
      <circle cx="10" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7"
      />
    </IconBase>
  );
}

export function MoonIcon() {
  return (
    <IconBase>
      <path
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        d="M16.5 12.3A6.75 6.75 0 0 1 7.7 3.5a6.75 6.75 0 1 0 8.8 8.8Z"
      />
    </IconBase>
  );
}

export function SystemIcon() {
  return (
    <IconBase>
      <rect x="2.75" y="4" width="14.5" height="9.5" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
      <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M7 16.5h6M10 13.5v3" />
    </IconBase>
  );
}
