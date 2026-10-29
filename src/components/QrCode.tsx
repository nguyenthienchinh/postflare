import { useMemo } from "react";
import { qrMatrix } from "../lib/qr";

/** QR code as one SVG path, dark modules on white whatever the theme (scanners need the contrast), 4-module quiet zone. */
export function QrCode({ value, size = 208, label }: { value: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const m = qrMatrix(value);
    let d = "";
    for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (m[r][c]) d += `M${c},${r}h1v1h-1z`;
    return { path: d, count: m.length };
  }, [value]);
  const q = 4;
  return (
    <svg width={size} height={size} viewBox={`${-q} ${-q} ${count + 2 * q} ${count + 2 * q}`} role="img" aria-label={label} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <rect x={-q} y={-q} width={count + 2 * q} height={count + 2 * q} fill="#fff" />
      <path d={path} fill="#09090b" />
    </svg>
  );
}
