// A small hand-drawn icon set (24px grid, 1.8 stroke). Inline so the strict CSP needs nothing extra.
const paths = {
  photos: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="1.6" /><path d="M21 16l-5-5-8 8" /></>,
  albums: <><rect x="3" y="7" width="14" height="14" rx="2.5" /><path d="M7 3h12a2 2 0 0 1 2 2v12" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" /></>,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c2 .8 3 2.6 3 5.6" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  download: <><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  next: <path d="M9 5l7 7-7 7" />,
  logout: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M16 8l4 4-4 4M20 12H9" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3" /></>,
  lock: <><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  select: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12.5l3 3 5-6" /></>,
  restore: <><path d="M4 12a8 8 0 1 0 3-6.2" /><path d="M4 4v4h4" /></>,
  folderPlus: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M10 9.5v5l4.5-2.5z" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  shield: <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" />,
  cloud: <path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5a4.2 4.2 0 0 1 0 8.5z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.8v.2" /></>,
  chevdown: <path d="M6 9l6 6 6-6" />,
  home: <><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /></>,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  map: <><path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z" /><path d="M9 4v13M15 6.5v13" /></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" />,
  slash: <><circle cx="12" cy="12" r="8" /><path d="M6.3 6.3l11.4 11.4" /></>,
  turnLeft: <><rect x="9" y="11" width="11" height="9" rx="2" /><path d="M13 4H9a5 5 0 0 0-5 5v4" /><path d="M1.5 10.5L4 13l2.5-2.5" /></>,
  turnRight: <><rect x="4" y="11" width="11" height="9" rx="2" /><path d="M11 4h4a5 5 0 0 1 5 5v4" /><path d="M17.5 10.5L20 13l2.5-2.5" /></>,
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, filled }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width={size} height={size} fill={filled ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

/** The mark, "Photo lock": one padlock whose body is the photo (ridge and sun cut out), as in the app icon (design/icon).
 *  Used in the logo and next to the storage meter; drawn in the theme's teal. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg class="mark" viewBox="0 0 24 24" width={size} height={size} fill="var(--teal)" aria-hidden="true" focusable="false">
      <path d="M6.6 10V7A5.4 5.4 0 0 1 17.4 7V10H14.4V7A2.4 2.4 0 0 0 9.6 7V10Z" />
      <path fill-rule="evenodd" d="M5.8 9.4H18.2A2.2 2.2 0 0 1 20.4 11.6V19.8A2.2 2.2 0 0 1 18.2 22H5.8A2.2 2.2 0 0 1 3.6 19.8V11.6A2.2 2.2 0 0 1 5.8 9.4ZM6.2 19.8L6.2 18L10.2 13.6L13.6 17.2L17.8 14.4L17.8 19.8ZM13.7 12.6A1.7 1.7 0 1 0 17.1 12.6A1.7 1.7 0 1 0 13.7 12.6Z" />
    </svg>
  );
}
