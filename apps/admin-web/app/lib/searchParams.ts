"use client";

import { useSearchParams } from "next/navigation";

export function useClientSearchParams() {
  return useSearchParams();
}
