// Spec: knowledge/components/spec-studio.md

import { treaty } from "@elysiajs/eden";
import type { App } from "@aeion-spec/server";

export function createApiClient(csrfToken?: string) {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "http://127.0.0.1:4170";

  return treaty<App>(origin, {
    fetch: {
      credentials: "include",
    },
    headers: csrfToken
      ? {
          "X-Aeion": "1",
          "X-CSRF-Token": csrfToken,
        }
      : {
          "X-Aeion": "1",
        },
  });
}

type StripErrorPayload<T> = Exclude<T, { error: string }>;

export async function unwrap<T>(
  promise: Promise<{ data: T | null; error: { value: unknown } | null }>,
): Promise<StripErrorPayload<T>> {
  const { data, error } = await promise;
  if (error) {
    const val = error.value as { error?: string; message?: string } | string | null;
    const msg =
      typeof val === "string"
        ? val
        : val?.error || val?.message || "Request failed";
    throw new Error(msg);
  }
  if (data === null || data === undefined) {
    throw new Error("Empty response received from server.");
  }
  if (
    typeof data === "object" &&
    "error" in data &&
    typeof (data as { error?: unknown }).error === "string"
  ) {
    throw new Error((data as { error: string }).error);
  }
  return data as StripErrorPayload<T>;
}
