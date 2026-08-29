import { createApiClient } from "@fin-hub/shared-api-client";

export const apiClient = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000",
});
