// The web app's hand-drawn icon set (24px grid, 1.8 stroke), drawn with react-native-svg.
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTheme } from "react-native-paper";
import type { AppTheme } from "./theme";

const paths = {
  map: <><Path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z" /><Path d="M9 4v13M15 6.5v13" /></>,
  photos: <><Rect x="3" y="3" width="18" height="18" rx="3" /><Circle cx="9" cy="9" r="1.6" /><Path d="M21 16l-5-5-8 8" /></>,
  upload: <><Path d="M12 16V4M7 9l5-5 5 5" /><Path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  check: <Path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <Path d="M6 6l12 12M18 6L6 18" />,
  back: <Path d="M15 5l-7 7 7 7" />,
  logout: <><Path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><Path d="M16 8l4 4-4 4M20 12H9" /></>,
  lock: <><Rect x="4" y="10" width="16" height="10" rx="2" /><Path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  video: <><Rect x="3" y="5" width="18" height="14" rx="3" /><Path d="M10 9.5v5l4.5-2.5z" /></>,
  info: <><Circle cx="12" cy="12" r="9" /><Path d="M12 11v5.5M12 7.8v.2" /></>,
  trash: <><Path d="M4 7h16" /><Path d="M9 7V4h6v3" /><Path d="M6 7l1 13h10l1-13" /><Path d="M10 11v5M14 11v5" /></>,
  cloud: <Path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5a4.2 4.2 0 0 1 0 8.5z" />,
  restore: <><Path d="M4 12a8 8 0 1 0 3-6.2" /><Path d="M4 4v4h4" /></>,
  key: <><Circle cx="8" cy="15" r="4" /><Path d="M11 12l9-9M16 7l3 3" /></>,
  user: <><Circle cx="12" cy="8.5" r="3.5" /><Path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" /></>,
  albums: <><Rect x="3" y="7" width="14" height="14" rx="2.5" /><Path d="M7 3h12a2 2 0 0 1 2 2v12" /></>,
  more: <><Circle cx="12" cy="5" r="1.4" /><Circle cx="12" cy="12" r="1.4" /><Circle cx="12" cy="19" r="1.4" /></>,
  edit: <><Path d="M4 20h4L19 9l-4-4L4 16z" /><Path d="M13.5 6.5l4 4" /></>,
  minus: <><Rect x="3" y="3" width="18" height="18" rx="3" /><Path d="M8 12h8" /></>,
  share: <><Circle cx="18" cy="5.5" r="2.5" /><Circle cx="6" cy="12" r="2.5" /><Circle cx="18" cy="18.5" r="2.5" /><Path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" /></>,
  folderPlus: <><Path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><Path d="M12 11v5M9.5 13.5h5" /></>,
  download: <><Path d="M12 4v12M7 11l5 5 5-5" /><Path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  plus: <Path d="M12 5v14M5 12h14" />,
  search: <><Circle cx="10.5" cy="10.5" r="6.5" /><Path d="M15.5 15.5L20 20" /></>,
  heart: <Path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  heartOn: <Path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  people: <><Circle cx="9" cy="8.5" r="3.2" /><Path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6" /><Path d="M15.5 5.6a3 3 0 0 1 0 5.8M18 13.6c1.8.9 3 2.9 3 5.4" /></>,
  phone: <><Rect x="6" y="2.5" width="12" height="19" rx="2.5" /><Path d="M10.5 18.5h3" /></>,
  similar: <><Rect x="3" y="3" width="11" height="11" rx="2" /><Rect x="10" y="10" width="11" height="11" rx="2" /></>,
  sparkle: <Path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  boxOff: <Rect x="3.5" y="3.5" width="17" height="17" rx="3" />,
  boxOn: <Rect x="3.5" y="3.5" width="17" height="17" rx="3" />,
  fingerprint: <><Path d="M7.5 5.5A7 7 0 0 1 19 11v1.5" /><Path d="M5 9a7 7 0 0 0-.5 2.5V14" /><Path d="M8.5 19.5A10 10 0 0 0 9 15v-3.5a3 3 0 0 1 6 0V14" /><Path d="M12 11.5V15a13 13 0 0 1-1.2 5.5" /><Path d="M15 17.5a12 12 0 0 1-.7 2.5" /><Path d="M18.6 15.5a13 13 0 0 1-.4 2" /></>,
} as const;

export type IconName = keyof typeof paths;

// names react-native-paper uses inside its own components (back arrow, close, menu)
const paperNames: Record<string, IconName> = {
  "arrow-left": "back", close: "x", "close-circle-outline": "x", check: "check",
  "checkbox-blank-outline": "boxOff", "checkbox-marked": "boxOn", "minus-box": "boxOn",
};

export function Icon({ name, size = 22, color }: { name: IconName | string; size?: number; color: string }) {
  const onFill = useTheme<AppTheme>().colors.onPrimary;
  const n = (name in paths ? name : paperNames[name]) as IconName | undefined;
  if (n === "heartOn") return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{paths.heartOn}</Svg>
  );
  // a ticked box is filled, with the tick in the color that reads on the fill
  if (n === "boxOn") return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3.5" y="3.5" width="17" height="17" rx="3" fill={color} stroke={color} strokeWidth={1.8} />
      <Path d="M7.5 12.3l3 3 6-6.3" stroke={onFill} strokeWidth={2.2} />
    </Svg>
  );
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {n ? paths[n] : null}
    </Svg>
  );
}
