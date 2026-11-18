// Spec: knowledge/components/spec-studio.md

import { proxyApiRequest } from "../../../lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export {
  proxyApiRequest as GET,
  proxyApiRequest as POST,
  proxyApiRequest as PUT,
  proxyApiRequest as PATCH,
  proxyApiRequest as DELETE,
  proxyApiRequest as OPTIONS,
  proxyApiRequest as HEAD,
};
