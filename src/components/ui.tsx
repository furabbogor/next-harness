"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export function HarnessMark({ small = false }: { small?: boolean }) {
  return <span className={`harness-mark${small ? " small" : ""}`} aria-hidden="true"><i /><i /><i /></span>;
}

export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label}><LoaderCircle size={17} className="spin" /></span>;
}

export function shortTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
export function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
export function formatCount(count: number) { return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count); }
