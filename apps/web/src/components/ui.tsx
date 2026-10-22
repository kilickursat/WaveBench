import { useEffect, useRef, useState, type ReactNode } from "react";

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

const PATHS = {
  logo: <path d="M2 12h3l2-6 4 13 4-15 3 8h4" />,
  open: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  trash: <path d="M5 7h14M10 11v6m4-6v6M8 7l1-3h6l1 3m-9 0 1 13h8l1-13" />,
  sun: <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  chip: <path d="M8 8h8v8H8zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3M6 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />,
  help: <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" />,
  zoomout: <path d="M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm5-2 5 5M7 10h6" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  wave: <path d="M2 12c2.5-7 4.5-7 7 0s4.5 7 7 0 4.5-7 6-3" />,
};

export function Menu({ label, icon, children, align = "left", title }: { label: ReactNode; icon?: keyof typeof PATHS; children: (close: () => void) => ReactNode; align?: "left" | "right"; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} title={title} onClick={() => setOpen((o) => !o)}>
        {icon && <Icon name={icon} />}
        <span className="label">{label}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className={`menu-panel ${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ title, detail, onClick, disabled }: { title: string; detail?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="menu-item" role="menuitem" onClick={onClick} disabled={disabled}>
      <span>{title}</span>
      {detail && <small>{detail}</small>}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A numeric text field that only commits finite values within range (on Enter or blur). */
export function NumberField({
  value, onCommit, min, max, integer, allowEmpty, className, ariaLabel, placeholder,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  allowEmpty?: boolean;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const parsed = text.trim() === "" ? null : Number(text);
  const valid =
    (parsed === null && !!allowEmpty) ||
    (parsed !== null && Number.isFinite(parsed) && (!integer || Number.isInteger(parsed)) && (min === undefined || parsed >= min) && (max === undefined || parsed <= max));
  const commit = () => {
    if (valid && parsed !== value) onCommit(parsed);
    else if (!valid) setText(value === null ? "" : String(value));
  };
  return (
    <input
      className={`input ${className ?? ""} ${valid ? "" : "invalid"}`}
      inputMode="decimal"
      value={text}
      aria-label={ariaLabel}
      aria-invalid={!valid}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(value === null ? "" : String(value));
      }}
    />
  );
}

export function Select<T extends string | number>({ value, options, onChange, ariaLabel, className }: { value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void; ariaLabel?: string; className?: string }) {
  return (
    <select
      className={`input ${className ?? ""}`}
      aria-label={ariaLabel}
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, children, wide, title }: { label: ReactNode; children: ReactNode; wide?: boolean; title?: string }) {
  return (
    <label className={`field ${wide ? "wide" : ""}`} title={title}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="content">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  );
}
