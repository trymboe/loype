"use client";

import NextLink from "next/link";
import type { ComponentProps } from "react";
import { changesScreen, startNavProgress } from "./feedback/nav-progress";

/**
 * `next/link` that starts the top loading bar the moment it navigates, so a
 * tap always gets visible feedback. Use this instead of importing next/link.
 */
export default function Link({ onNavigate, ...props }: ComponentProps<typeof NextLink>) {
  return (
    <NextLink
      {...props}
      onNavigate={(e) => {
        onNavigate?.(e);
        const href = typeof props.href === "string" ? props.href : (props.as?.toString() ?? null);
        if (href === null || changesScreen(href)) startNavProgress();
      }}
    />
  );
}
