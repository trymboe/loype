import clsx from "clsx";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  action,
  eyebrow,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6">
      {back && <BackLink href={back.href}>{back.label}</BackLink>}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
          <h1 className="text-[2rem] leading-[1.1] font-bold tracking-[-0.03em] text-balance">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[0.9375rem] leading-snug text-muted text-pretty">{subtitle}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="-ml-1.5 mb-3 inline-flex min-h-9 items-center gap-0.5 rounded-lg pr-2 text-[0.9375rem] font-medium text-accent">
      <ChevronLeft size={20} strokeWidth={2.2} /> {children}
    </Link>
  );
}

const STAT_SIZES = {
  xl: "text-[2.75rem]",
  lg: "text-[1.75rem]",
  md: "text-[1.5rem]",
  sm: "text-[1.125rem]",
};

export function Stat({
  label,
  value,
  unit,
  hint,
  className,
  size = "lg",
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  className?: string;
  size?: keyof typeof STAT_SIZES;
}) {
  return (
    <div className={clsx("min-w-0", className)}>
      <div className="label truncate">{label}</div>
      <div className={clsx("display mt-1.5 whitespace-nowrap", STAT_SIZES[size])}>
        {value}
        {unit && <span className="ml-1 text-[0.8125rem] font-medium tracking-normal text-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-1.5 text-xs leading-snug text-muted">{hint}</div>}
    </div>
  );
}

export function Card({ children, className, href }: { children: ReactNode; className?: string; href?: string }) {
  const cls = clsx("card block p-5", href && "hover:bg-surface-2/40", className);
  return href ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : (
    <section className={cls}>{children}</section>
  );
}

/** Title row inside a card: heading on the left, a quiet aside or link on the right. */
export function CardHeader({ title, aside, className }: { title: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-baseline justify-between gap-3", className)}>
      <h2 className="section-title">{title}</h2>
      {aside && <div className="shrink-0 text-xs text-muted">{aside}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card rise px-6 py-8 text-center">
      {icon && <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">{icon}</div>}
      <p className="text-[1.0625rem] font-semibold tracking-[-0.01em]">{title}</p>
      <div className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted text-pretty">{children}</div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export type Tone = "muted" | "warn" | "accent" | "hr" | "good";

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  const tones: Record<Tone, string> = {
    muted: "bg-surface-2 text-muted",
    warn: "bg-warn/12 text-warn",
    accent: "bg-accent/12 text-accent",
    hr: "bg-danger/12 text-danger",
    good: "bg-good/12 text-good",
  };
  return (
    <span className={clsx("inline-flex h-[1.375rem] items-center gap-1 rounded-full px-2 text-[0.6875rem] font-semibold whitespace-nowrap", tones[tone])}>
      {children}
    </span>
  );
}

export function ButtonLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" | "accent" }) {
  return (
    <Link href={href} className={clsx("btn", `btn-${variant}`)}>
      {children}
    </Link>
  );
}

/** Small coloured square holding an icon, as used in settings-style lists. */
export function IconTile({ children, color = "var(--muted)" }: { children: ReactNode; color?: string }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-[0.625rem]"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {children}
    </span>
  );
}
