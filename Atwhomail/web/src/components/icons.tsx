/** 手寫 inline SVG 圖示（不引入 icon 套件） */
import type { ReactNode } from "react";

interface IconProps {
  size?: number;
}

function Svg({ size = 18, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconCompose = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);

export const IconInbox = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
  </Svg>
);

export const IconSend = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </Svg>
);

export const IconArchive = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </Svg>
);

export const IconSpam = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
);

export const IconTrash = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Svg>
);

export const IconSearch = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);

export const IconPaperclip = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </Svg>
);

export const IconReply = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 6 6v5" />
  </Svg>
);

export const IconReplyAll = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m7 14-5-5 5-5" />
    <path d="m12 14-5-5 5-5" />
    <path d="M7 9h7a6 6 0 0 1 6 6v5" />
  </Svg>
);

export const IconForward = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0-6 6v5" />
  </Svg>
);

export const IconClose = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
);

export const IconRefresh = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </Svg>
);

export const IconBack = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const IconMenu = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 6h18" />
    <path d="M3 12h18" />
    <path d="M3 18h18" />
  </Svg>
);

export const IconMailOpen = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2 9V7a2 2 0 0 1 1-1.73l8-4a2 2 0 0 1 2 0l8 4A2 2 0 0 1 22 7v2" />
    <path d="M2 9h20v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" />
    <path d="m2 10 8.97 5.7a2 2 0 0 0 2.06 0L22 10" />
  </Svg>
);

export const IconMail = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m2 7 8.97 5.7a2 2 0 0 0 2.06 0L22 7" />
  </Svg>
);

export const IconPlus = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);

export const IconKey = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 8.3-8.3" />
    <path d="m17 6 2 2" />
    <path d="m14 9 2 2" />
  </Svg>
);

export const IconLogout = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Svg>
);

/** 邀請碼（票券） */
export const IconTicket = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
    <path d="M13 5v2" />
    <path d="M13 11v2" />
    <path d="M13 17v2" />
  </Svg>
);

export const IconUsers = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconFile = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </Svg>
);

export const IconDownload = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </Svg>
);

export const IconFolder = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </Svg>
);
