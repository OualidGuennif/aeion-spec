// Spec: knowledge/components/spec-studio.md

const API_ORIGIN = (
  process.env.AEION_INTERNAL_API_ORIGIN || "http://127.0.0.1:4171"
).replace(/\/+$/, "");

// Long interview and automated review runs can legitimately exceed Next's 30 s rewrite socket limit.
const PROXY_TIMEOUT_MS = 300_000;
const MAX_PROXY_BODY_BYTES = 105 * 1024 * 1024;

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "proxy-connection",
  "accept-encoding",
]);

const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

function copySetCookies(from: Headers, to: Headers): void {
  const getSetCookie = (from as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    for (const cookie of getSetCookie.call(from)) {
      to.append("set-cookie", cookie);
    }
    return;
  }
  const single = from.get("set-cookie");
  if (single) to.append("set-cookie", single);
}

class ProxyPayloadTooLargeError extends Error {}

function payloadTooLargeResponse(): Response {
  return Response.json({ error: "Upload exceeds strict 100 MiB archive limit." }, { status: 413 });
}

function boundRequestStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          onLimit();
          controller.error(new ProxyPayloadTooLargeError("Payload exceeds limit."));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Stream requests and responses (including SSE) to the Elysia backend without the 30 s rewrite socket cap. */
export async function forwardApiRequest(
  req: Request,
  options: { targetOrigin?: string; maxBodyBytes?: number } = {},
): Promise<Response> {
  const maxBytes = options.maxBodyBytes ?? MAX_PROXY_BODY_BYTES;
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return payloadTooLargeResponse();
  }

  const origin = (options.targetOrigin || API_ORIGIN).replace(/\/+$/, "");
  const incoming = new URL(req.url);
  const targetUrl = `${origin}${incoming.pathname}${incoming.search}`;

  const reqHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!DROP_REQUEST_HEADERS.has(key.toLowerCase())) {
      reqHeaders.append(key, value);
    }
  });

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const timeoutSignal = AbortSignal.timeout(PROXY_TIMEOUT_MS);
  const signal =
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([req.signal, timeoutSignal])
      : timeoutSignal;

  let exceededLimit = false;
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: reqHeaders,
    cache: "no-store",
    redirect: "manual",
    signal,
  };
  if (hasBody && req.body) {
    init.body = boundRequestStream(req.body, maxBytes, () => {
      exceededLimit = true;
    });
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    if (exceededLimit || err instanceof ProxyPayloadTooLargeError) {
      return payloadTooLargeResponse();
    }
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return Response.json(
      {
        error: timedOut
          ? "Backend request timed out after 300 s."
          : "Backend API is unreachable.",
      },
      { status: timedOut ? 504 : 502 },
    );
  }

  if (exceededLimit) {
    void upstream.body?.cancel().catch(() => undefined);
    return payloadTooLargeResponse();
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      resHeaders.append(key, value);
    }
  });
  copySetCookies(upstream.headers, resHeaders);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

/** Next.js App Router entrypoint for /api/* and /v1/* proxy handlers. */
export function proxyApiRequest(req: Request): Promise<Response> {
  return forwardApiRequest(req);
}
