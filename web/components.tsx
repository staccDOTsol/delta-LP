import { useEffect, useRef, type ReactNode } from 'react';
import { X, ArrowUpRight, LoaderCircle } from 'lucide-react';

export const cad = (cents: number, digits = 0) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(cents / 100);
export const number = (n: number, digits = 0) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: digits }).format(n);
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}><span className="badge-dot" />{children}</span>; }
export function Stat({ label, value, note, accent }: { label: string; value: string; note: string; accent?: boolean }) { return <article className={`stat ${accent ? 'accent' : ''}`}><div className="stat-label">{label}<ArrowUpRight size={16}/></div><strong>{value}</strong><span>{note}</span></article>; }
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="modal" aria-label={title} onCancel={onClose} onClick={event => { if (event.target === ref.current) onClose(); }}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></header>{children}</dialog>;
}
export function Submit({ busy, children }: { busy: boolean; children: ReactNode }) { return <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16}/> : null}{children}</button>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function CashChart({ rows }: { rows: { month: string; cashCents: number }[] }) {
  const width = 740, height = 210, padding = 30;
  const max = Math.max(1, ...rows.map(r => r.cashCents)), min = Math.min(0, ...rows.map(r => r.cashCents));
  const x = (i: number) => padding + i / Math.max(rows.length - 1, 1) * (width - padding * 2);
  const y = (v: number) => 15 + (max - v) / (max - min || 1) * (height - 50);
  const line = rows.map((r, i) => `${x(i)},${y(r.cashCents)}`).join(' ');
  return <svg className="cash-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Projected cash from ${rows[0]?.month} to ${rows.at(-1)?.month}. Minimum ${cad(min)}, maximum ${cad(max)}.`}>
    <defs><linearGradient id="cash-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#5c9c82" stopOpacity="0.2"/><stop offset="100%" stopColor="#5c9c82" stopOpacity="0.015"/></linearGradient></defs>
    {[0, .5, 1].map(t => <line key={t} x1={padding} x2={width - padding} y1={15 + t * (height - 50)} y2={15 + t * (height - 50)} stroke="#e5e8de" strokeDasharray="4 5"/>)}
    <polygon points={`${padding},${y(0)} ${line} ${x(rows.length - 1)},${y(0)}`} fill="url(#cash-area)"/>
    <line x1={padding} x2={width - padding} y1={y(0)} y2={y(0)} stroke="#b2bcae"/>
    <polyline points={line} fill="none" stroke="#33745d" strokeWidth="2.5" strokeLinejoin="round"/>
    {rows.map((r, i) => <g key={r.month}><circle cx={x(i)} cy={y(r.cashCents)} r={3} fill={r.cashCents < 0 ? '#b6633f' : '#33745d'}><title>{r.month}: {cad(r.cashCents)}</title></circle><text x={x(i)} y={height - 5} textAnchor="middle" fill="#7e867d" fontSize="10">{r.month}</text></g>)}
  </svg>;
}
