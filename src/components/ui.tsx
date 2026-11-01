import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-4xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
  className,
  size = "lg",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  className?: string;
  size?: "lg" | "md";
}) {
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="label">{label}</div>
      <div className={clsx("tabular mt-1 font-display font-semibold leading-none", size === "lg" ? "text-3xl" : "text-2xl")}>
        {value}
        {unit && <span className="ml-1 font-sans text-sm font-normal text-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Card({ children, className, href }: { children: ReactNode; className?: string; href?: string }) {
  const cls = clsx("card rise block p-5", href && "transition-colors hover:border-muted/50", className);
  return href ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : (
    <section className={cls}>{children}</section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card rise p-6">
      <p className="font-semibold">{title}</p>
      <div className="mt-1 text-sm text-muted">{children}</div>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "accent" | "hr" }) {
  const tones = {
    muted: "bg-surface-2 text-muted",
    warn: "bg-warn/15 text-warn",
    accent: "bg-accent/15 text-accent",
    hr: "bg-hr/15 text-hr",
  };
  return <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold", tones[tone])}>{children}</span>;
}

export function ButtonLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg">
      {children}
    </Link>
  );
}
