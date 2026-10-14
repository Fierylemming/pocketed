import type { SVGProps } from "react";

const paths = {
  pocket: "M4 4h16v10c0 4-8 7-8 7s-8-3-8-7V4Zm4 6 4 4 4-4",
  home: "M3 10 12 3l9 7v10H3V10Zm6 10v-7h6v7",
  note: "M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6",
  calendar: "M4 5h16v16H4V5Zm3-3v6m10-6v6M4 10h16M8 14h2m4 0h2m-8 3h2",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  folder: "M3 5h7l2 3h9v12H3V5Z",
  search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  settings: "M4 7h16M4 17h16M9 4v6m6 4v6",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z",
  monitor: "M3 4h18v13H3V4Zm5 17h8m-4-4v4",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  pin: "m9 3 12 12-4 1-3 4-3-7-7-3 4-3 1-4ZM3 21l6-6",
  check: "m5 12 4 4L19 6",
  image: "M3 3h18v18H3V3Zm0 13 6-6 12 11M15 7h.01",
  list: "M9 6h12M9 12h12M9 18h12M3 6h1m-1 6h1m-1 6h1",
  download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  expand: "M14 3h7v7m0-7-7 7M10 21H3v-7m0 7 7-7",
  location: "M12 22s8-8 8-14a8 8 0 1 0-16 0c0 6 8 14 8 14ZM15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  sync: "M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5",
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>;
}

export function Brand() {
  return <div className="workspace"><span className="workspace-logo"><Icon name="pocket" /></span><span className="workspace-name">pocketed<span className="brand-dot">.</span></span></div>;
}
